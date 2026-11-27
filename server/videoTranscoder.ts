import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { requireServerOperator } from './aiProviders/authMiddleware';
import { videoTranscodeLimiter } from './rateLimiters';

const execFileAsync = promisify(execFile);

const MAX_TRANSCODE_INPUT_BYTES = 160 * 1024 * 1024; // 160 MB max raw upload
const FFMPEG_TIMEOUT_MS = 120_000;

function getMaxConcurrentTranscodes(): number {
  const raw = Number(process.env.MAX_CONCURRENT_TRANSCODES);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 4) {
    return Math.floor(raw);
  }
  return 2;
}

class TranscodeSemaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    const limit = getMaxConcurrentTranscodes();
    if (this.active < limit) {
      this.active += 1;
      return this.createReleaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.queue = this.queue.filter((fn) => fn !== grant);
        reject(new Error('Transcode request aborted while waiting for FFmpeg worker slot.'));
      };
      const grant = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve(this.createReleaser());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

const transcodeSemaphore = new TranscodeSemaphore();

export interface Mp4InspectionResult {
  valid: boolean;
  reason?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  pixelFormat?: string;
  sampleRate?: number;
  channels?: number;
  faststart?: boolean;
  hasFtyp?: boolean;
  hasMoovBeforeMdat?: boolean;
}

export function inspectMp4AtomOrder(buffer: Buffer): {
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
  moovBeforeMdat: boolean;
} {
  let offset = 0;
  let hasFtyp = false;
  let moovOffset = -1;
  let mdatOffset = -1;

  while (offset + 8 <= buffer.length) {
    const size32 = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);
    let boxSize = size32;
    if (size32 === 1 && offset + 16 <= buffer.length) {
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
    } else if (size32 === 0) {
      boxSize = buffer.length - offset;
    }

    if (boxSize < 8 || offset + boxSize > buffer.length) {
      break;
    }

    if (boxType === 'ftyp') hasFtyp = true;
    if (boxType === 'moov' && moovOffset === -1) moovOffset = offset;
    if (boxType === 'mdat' && mdatOffset === -1) mdatOffset = offset;

    offset += boxSize;
  }

  return {
    hasFtyp,
    hasMoov: moovOffset !== -1,
    hasMdat: mdatOffset !== -1,
    moovBeforeMdat: moovOffset !== -1 && (mdatOffset === -1 || moovOffset < mdatOffset),
  };
}

/**
 * Parses top-level MP4 boxes directly from disk using 16-byte positional reads
 * so verifying a 50-100 MB MP4 takes <4 KB of heap instead of loading the file into RAM.
 */
export async function inspectMp4AtomOrderFromFile(filePath: string): Promise<{
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
  moovBeforeMdat: boolean;
  fileSize: number;
}> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const fileSize = stat.size;
    const headerBuf = Buffer.alloc(16);
    let offset = 0;
    let hasFtyp = false;
    let moovOffset = -1;
    let mdatOffset = -1;

    while (offset + 8 <= fileSize) {
      const { bytesRead } = await fh.read(headerBuf, 0, Math.min(16, fileSize - offset), offset);
      if (bytesRead < 8) break;

      const size32 = headerBuf.readUInt32BE(0);
      const boxType = headerBuf.toString('ascii', 4, 8);
      let boxSize = size32;
      if (size32 === 1 && bytesRead >= 16) {
        boxSize = Number(headerBuf.readBigUInt64BE(8));
      } else if (size32 === 0) {
        boxSize = fileSize - offset;
      }

      if (!Number.isFinite(boxSize) || boxSize < 8 || offset + boxSize > fileSize) {
        break;
      }

      if (boxType === 'ftyp') hasFtyp = true;
      if (boxType === 'moov' && moovOffset === -1) moovOffset = offset;
      if (boxType === 'mdat' && mdatOffset === -1) mdatOffset = offset;

      offset += boxSize;
    }

    return {
      hasFtyp,
      hasMoov: moovOffset !== -1,
      hasMdat: mdatOffset !== -1,
      moovBeforeMdat: moovOffset !== -1 && (mdatOffset === -1 || moovOffset < mdatOffset),
      fileSize,
    };
  } finally {
    await fh.close();
  }
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 0;
  if (raw.includes('/')) {
    const [num, den] = raw.split('/').map(Number);
    return den > 0 ? Number((num / den).toFixed(2)) : 0;
  }
  return Number(raw) || 0;
}

export async function probeAndValidateMp4(
  filePath: string,
  expected?: { width: number; height: number; fps: number }
): Promise<Mp4InspectionResult> {
  const atoms = await inspectMp4AtomOrderFromFile(filePath);
  if (!atoms.hasFtyp || !atoms.hasMoov || !atoms.hasMdat || !atoms.moovBeforeMdat) {
    return {
      valid: false,
      reason: `Invalid MP4 atom layout (ftyp=${atoms.hasFtyp}, moov=${atoms.hasMoov}, mdat=${atoms.hasMdat}, faststart=${atoms.moovBeforeMdat}).`,
      hasFtyp: atoms.hasFtyp,
      hasMoovBeforeMdat: atoms.moovBeforeMdat,
    };
  }

  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      profile?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
  };

  const formatName = (parsed.format?.format_name || '').toLowerCase();
  if (!formatName.includes('mp4')) {
    return { valid: false, reason: `Unexpected container format "${formatName}" (expected MP4).` };
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!videoStream || videoStream.codec_name !== 'h264') {
    return {
      valid: false,
      reason: `Video stream must be H.264 (got "${videoStream?.codec_name || 'none'}").`,
    };
  }
  if (videoStream.pix_fmt !== 'yuv420p') {
    return {
      valid: false,
      reason: `Video pixel format must be yuv420p (got "${videoStream.pix_fmt || 'unknown'}").`,
    };
  }
  if (
    expected &&
    (videoStream.width !== expected.width || videoStream.height !== expected.height)
  ) {
    return {
      valid: false,
      reason: `Unexpected video dimensions ${videoStream.width}x${videoStream.height} (expected ${expected.width}x${expected.height}).`,
    };
  }

  if (!audioStream || audioStream.codec_name !== 'aac') {
    return {
      valid: false,
      reason: `Audio stream must be AAC stereo for Instagram/YouTube ingestion (got "${audioStream?.codec_name || 'none'}").`,
    };
  }

  const duration = Number(parsed.format?.duration || videoStream.duration || 0);
  const fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);
  const sampleRate = Number(audioStream.sample_rate || 0);
  const channels = Number(audioStream.channels || 0);

  if (sampleRate !== 44100 || channels !== 2) {
    return {
      valid: false,
      reason: `Audio stream must be 44100 Hz stereo (got ${sampleRate} Hz, ${channels}ch).`,
    };
  }
  if (expected && Math.abs(fps - expected.fps) > 0.5) {
    return {
      valid: false,
      reason: `Video frame rate must be constant ${expected.fps} FPS (got ${fps} FPS).`,
    };
  }
  if (duration <= 0 || duration > 95) {
    return {
      valid: false,
      reason: `Duration (${duration.toFixed(2)}s) must be between 0.5s and 95s for Reels/Shorts.`,
    };
  }

  return {
    valid: true,
    videoCodec: videoStream.codec_name,
    audioCodec: audioStream.codec_name,
    width: videoStream.width,
    height: videoStream.height,
    fps,
    duration,
    pixelFormat: videoStream.pix_fmt,
    sampleRate,
    channels,
    faststart: atoms.moovBeforeMdat,
    hasFtyp: atoms.hasFtyp,
    hasMoovBeforeMdat: atoms.moovBeforeMdat,
  };
}

function runFfmpegWithAbort(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error('Client disconnected during MP4 transcode; FFmpeg process terminated.'));
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(new Error(`FFmpeg transcoding exceeded ${FFMPEG_TIMEOUT_MS / 1000}s timeout.`));
    }, FFMPEG_TIMEOUT_MS);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`FFmpeg exited with code ${code}: ${stderrTail.trim().slice(-400)}`));
      }
    });
  });
}

export async function transcodeFileToSocialMp4(opts: {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  maxDurationSeconds: number;
  abortSignal?: AbortSignal;
}): Promise<{ outputPath: string; outputSize: number; inspection: Mp4InspectionResult }> {
  const release = await transcodeSemaphore.acquire(opts.abortSignal);
  try {
    let hasInputAudio = false;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'json',
        opts.inputPath,
      ]);
      const probeJson = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
      hasInputAudio = Boolean(probeJson.streams && probeJson.streams.length > 0);
    } catch {
      hasInputAudio = false;
    }

    const targetW = opts.width % 2 === 0 ? opts.width : opts.width - 1;
    const targetH = opts.height % 2 === 0 ? opts.height : opts.height - 1;
    const targetFps = Math.max(24, Math.min(60, Math.round(opts.fps || 30)));
    const clampedDuration = Math.max(1, Math.min(95, Number(opts.maxDurationSeconds) || 30));

    const args: string[] = ['-y', '-threads', '2', '-i', opts.inputPath];

    if (!hasInputAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0');
    }

    args.push(
      '-t',
      clampedDuration.toFixed(3),
      '-vf',
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`,
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(targetFps),
      '-vsync',
      'cfr',
      '-g',
      String(targetFps * 2),
      '-keyint_min',
      String(targetFps),
      '-sc_threshold',
      '0',
      '-b:v',
      '5000k',
      '-maxrate',
      '6500k',
      '-bufsize',
      '10000k',
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-brand',
      'mp42',
      opts.outputPath
    );

    await runFfmpegWithAbort(args, opts.abortSignal);

    const inspection = await probeAndValidateMp4(opts.outputPath, {
      width: targetW,
      height: targetH,
      fps: targetFps,
    });
    if (!inspection.valid) {
      throw new Error(inspection.reason || 'Transcoded MP4 failed container/codec verification.');
    }

    const stat = await fs.promises.stat(opts.outputPath);
    return { outputPath: opts.outputPath, outputSize: stat.size, inspection };
  } finally {
    release();
  }
}

export async function transcodeBufferToSocialMp4(opts: {
  inputBuffer: Buffer;
  width: number;
  height: number;
  fps: number;
  maxDurationSeconds: number;
}): Promise<{ mp4Buffer: Buffer; inspection: Mp4InspectionResult }> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), '74studio-mp4-'));
  const inputPath = path.join(workDir, `raw-${crypto.randomBytes(4).toString('hex')}.bin`);
  const outputPath = path.join(workDir, 'social-ready.mp4');

  try {
    await fs.promises.writeFile(inputPath, opts.inputBuffer);
    const result = await transcodeFileToSocialMp4({
      inputPath,
      outputPath,
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      maxDurationSeconds: opts.maxDurationSeconds,
    });
    const mp4Buffer = await fs.promises.readFile(result.outputPath);
    return { mp4Buffer, inspection: result.inspection };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function streamRequestBodyToFile(
  req: Request,
  destPath: string,
  maxBytes: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let received = 0;
    let settled = false;

    const abortAndReject = (err: Error & { statusCode?: number }) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      reject(err);
    };

    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      const err = new Error(`Upload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`) as Error & { statusCode?: number };
      err.statusCode = 413;
      abortAndReject(err);
      return;
    }

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        const err = new Error(`Upload exceeds maximum allowed size (${Math.round(maxBytes / (1024 * 1024))} MB).`) as Error & { statusCode?: number };
        err.statusCode = 413;
        abortAndReject(err);
      }
    });

    req.on('aborted', () => {
      const err = new Error('Upload stream aborted by client.') as Error & { statusCode?: number };
      err.statusCode = 499;
      abortAndReject(err);
    });

    req.on('error', (err) => abortAndReject(err));
    out.on('error', (err) => abortAndReject(err));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });

    req.pipe(out);
  });
}

export function registerVideoTranscoder(app: Express) {
  const videoAuthGuard = requireServerOperator('ws-behind-the-release');
  app.post(
    '/api/video/transcode-mp4',
    videoAuthGuard,
    videoTranscodeLimiter,
    async (req: Request, res: Response) => {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType && !contentType.startsWith('video/') && !contentType.includes('application/octet-stream')) {
        return res.status(415).json({
          error: 'Raw binary video payload (video/* or application/octet-stream) is required.',
        });
      }

      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), '74studio-mp4-'));
      const inputPath = path.join(workDir, `raw-${crypto.randomBytes(4).toString('hex')}.bin`);
      const outputPath = path.join(workDir, 'social-ready.mp4');

      let cleaned = false;
      const cleanupWorkDir = () => {
        if (cleaned) return;
        cleaned = true;
        fs.rm(workDir, { recursive: true, force: true }, () => {});
      };

      const abortController = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      res.on('close', onClose);

      try {
        const receivedBytes = await streamRequestBodyToFile(req, inputPath, MAX_TRANSCODE_INPUT_BYTES);
        if (receivedBytes < 128) {
          cleanupWorkDir();
          return res.status(400).json({
            error: 'Valid raw video binary payload is required for social MP4 transcoding.',
          });
        }

        const rawW = Number(req.query.width) || 1080;
        const rawH = Number(req.query.height) || 1920;
        const width = Math.max(128, Math.min(3840, Math.round(rawW)));
        const height = Math.max(128, Math.min(3840, Math.round(rawH)));
        const fps = Math.max(24, Math.min(60, Math.round(Number(req.query.fps) || 30)));
        const duration = Math.max(1, Math.min(95, Number(req.query.duration) || 30));

        const { outputSize, inspection } = await transcodeFileToSocialMp4({
          inputPath,
          outputPath,
          width,
          height,
          fps,
          maxDurationSeconds: duration,
          abortSignal: abortController.signal,
        });

        // Input is no longer needed once transcoded output is verified
        fs.rm(inputPath, { force: true }, () => {});

        if (res.writableEnded || abortController.signal.aborted) {
          cleanupWorkDir();
          return;
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(outputSize));
        res.setHeader('X-Video-Codec', inspection.videoCodec || 'h264');
        res.setHeader('X-Audio-Codec', inspection.audioCodec || 'aac');
        res.setHeader('X-Video-Resolution', `${inspection.width}x${inspection.height}`);
        res.setHeader('X-Video-Fps', String(inspection.fps || fps));
        res.setHeader('X-Faststart-Verified', String(Boolean(inspection.faststart)));
        res.setHeader('X-Video-Duration', String(inspection.duration || duration));

        const readStream = fs.createReadStream(outputPath);
        res.once('finish', cleanupWorkDir);
        res.once('close', () => {
          readStream.destroy();
          cleanupWorkDir();
        });
        readStream.once('error', () => {
          cleanupWorkDir();
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream transcoded MP4.' });
          } else {
            res.end();
          }
        });
        return readStream.pipe(res);
      } catch (err) {
        cleanupWorkDir();
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const msg = err instanceof Error ? err.message : 'MP4 transcoding failed.';
        if (res.headersSent) return res.end();
        return res.status(statusCode === 413 ? 413 : 500).json({
          error: `Social-compatible MP4 encoding failed: ${msg}`,
        });
      } finally {
        res.off('close', onClose);
      }
    }
  );
}
