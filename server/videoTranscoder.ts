import { execFile } from 'child_process';
import crypto from 'crypto';
import express, { Express, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { requireServerOperator } from './aiProviders/authMiddleware';
import { videoTranscodeLimiter } from './rateLimiters';

const execFileAsync = promisify(execFile);

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
      const big = Number(buffer.readBigUInt64BE(offset + 8));
      boxSize = big;
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
  const buffer = fs.readFileSync(filePath);
  const atoms = inspectMp4AtomOrder(buffer);
  if (!atoms.hasFtyp || !atoms.hasMoov || !atoms.moovBeforeMdat) {
    return {
      valid: false,
      reason: `Invalid MP4 atom layout (ftyp=${atoms.hasFtyp}, moov=${atoms.hasMoov}, faststart=${atoms.moovBeforeMdat}).`,
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
    fs.writeFileSync(inputPath, opts.inputBuffer);

    // Probe input streams to check whether an audio track already exists
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
        inputPath,
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

    const args: string[] = ['-y', '-i', inputPath];

    if (!hasInputAudio) {
      // Synthesize valid stereo 44.1kHz silent AAC track when user has no music/voiceover
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
      outputPath
    );

    await execFileAsync('ffmpeg', args, { maxBuffer: 20 * 1024 * 1024 });

    const inspection = await probeAndValidateMp4(outputPath, {
      width: targetW,
      height: targetH,
      fps: targetFps,
    });
    if (!inspection.valid) {
      throw new Error(inspection.reason || 'Transcoded MP4 failed container/codec verification.');
    }

    const mp4Buffer = fs.readFileSync(outputPath);
    return { mp4Buffer, inspection };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function registerVideoTranscoder(app: Express) {
  const videoAuthGuard = requireServerOperator('ws-behind-the-release');
  app.post(
    '/api/video/transcode-mp4',
    videoAuthGuard,
    videoTranscodeLimiter,
    express.raw({
      type: ['video/*', 'application/octet-stream'],
      limit: '160mb',
    }),
    async (req: Request, res: Response) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 128) {
        return res.status(400).json({
          error: 'Valid raw video binary payload is required for social MP4 transcoding.',
        });
      }

      const width = Number(req.query.width) || 1080;
      const height = Number(req.query.height) || 1920;
      const fps = Number(req.query.fps) || 30;
      const duration = Number(req.query.duration) || 30;

      try {
        const { mp4Buffer, inspection } = await transcodeBufferToSocialMp4({
          inputBuffer: body,
          width,
          height,
          fps,
          maxDurationSeconds: duration,
        });

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(mp4Buffer.length));
        res.setHeader('X-Video-Codec', inspection.videoCodec || 'h264');
        res.setHeader('X-Audio-Codec', inspection.audioCodec || 'aac');
        res.setHeader('X-Video-Resolution', `${inspection.width}x${inspection.height}`);
        res.setHeader('X-Video-Fps', String(inspection.fps || fps));
        res.setHeader('X-Faststart-Verified', String(Boolean(inspection.faststart)));
        res.setHeader('X-Video-Duration', String(inspection.duration || duration));
        return res.send(mp4Buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'MP4 transcoding failed.';
        return res.status(500).json({
          error: `Social-compatible MP4 encoding failed: ${msg}`,
        });
      }
    }
  );
}
