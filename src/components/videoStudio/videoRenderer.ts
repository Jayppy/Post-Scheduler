import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import type { VideoProject } from '../../types/videoStudio';
import {
  BehindTheReleaseVideoComposition,
  type RemotionVideoProps,
} from './RemotionComposition';
import { getOperatorAuthHeaders } from '../../services/authHeaders';

export type VideoExportResolution = '1080x1920' | '540x960' | '1920x1080';

export interface RawRenderBackup {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
}

export interface RenderExportOptions {
  project: VideoProject;
  resolution: VideoExportResolution;
  fps?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, statusLabel: string) => void;
  onRawRenderBackup?: (raw: RawRenderBackup) => void | Promise<void>;
}

export interface RenderExportResult {
  blob: Blob;
  format: 'mp4';
  mimeType: 'video/mp4';
  engine: 'remotion-web' | 'canvas-ffmpeg-fallback';
  durationSeconds: number;
  width: number;
  height: number;
}

export function resolveExportDimensions(resolution: VideoExportResolution): {
  width: number;
  height: number;
} {
  if (resolution === '540x960') return { width: 540, height: 960 };
  if (resolution === '1920x1080') return { width: 1920, height: 1080 };
  return { width: 1080, height: 1920 };
}

export function computeProjectDurationFrames(project: VideoProject, fps: number): number {
  const totalSec = project.scenes.reduce((acc, s) => acc + Math.max(1, s.durationSeconds), 0);
  return Math.max(fps * 2, Math.round(totalSec * fps));
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = 0; i < len && start + i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[start + i]);
  }
  return out;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function containsFourCC(bytes: Uint8Array, fourcc: string): boolean {
  const c0 = fourcc.charCodeAt(0);
  const c1 = fourcc.charCodeAt(1);
  const c2 = fourcc.charCodeAt(2);
  const c3 = fourcc.charCodeAt(3);
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (bytes[i] === c0 && bytes[i + 1] === c1 && bytes[i + 2] === c2 && bytes[i + 3] === c3) {
      return true;
    }
  }
  return false;
}

export function validateMp4ContainerBytes(bytes: Uint8Array): {
  valid: boolean;
  reason?: string;
} {
  if (bytes.length < 64) {
    return { valid: false, reason: 'MP4 output is empty or truncated.' };
  }

  let offset = 0;
  let hasFtyp = false;
  let moovStart = -1;
  let moovEnd = -1;
  let mdatStart = -1;

  while (offset + 8 <= bytes.length) {
    let boxSize = readUint32BE(bytes, offset);
    const boxType = readAscii(bytes, offset + 4, 4);

    if (boxSize === 1 && offset + 16 <= bytes.length) {
      const hi = readUint32BE(bytes, offset + 8);
      const lo = readUint32BE(bytes, offset + 12);
      boxSize = hi * 4294967296 + lo;
    } else if (boxSize === 0) {
      boxSize = bytes.length - offset;
    }

    if (boxSize < 8 || offset + boxSize > bytes.length) {
      break;
    }

    if (boxType === 'ftyp') hasFtyp = true;
    if (boxType === 'moov' && moovStart === -1) {
      moovStart = offset;
      moovEnd = offset + boxSize;
    }
    if (boxType === 'mdat' && mdatStart === -1) {
      mdatStart = offset;
    }

    offset += boxSize;
  }

  if (!hasFtyp || moovStart === -1 || mdatStart === -1) {
    return {
      valid: false,
      reason: `Invalid MP4 container atoms (ftyp=${hasFtyp}, moov=${moovStart !== -1}, mdat=${mdatStart !== -1}).`,
    };
  }

  if (moovStart >= mdatStart) {
    return {
      valid: false,
      reason: 'MP4 moov atom is placed after mdat (missing +faststart).',
    };
  }

  const moovSlice = bytes.subarray(moovStart, moovEnd);
  const hasAvc1 = containsFourCC(moovSlice, 'avc1');
  const hasMp4a = containsFourCC(moovSlice, 'mp4a');
  if (!hasAvc1 || !hasMp4a) {
    return {
      valid: false,
      reason: `Unexpected MP4 codecs (avc1=${hasAvc1}, mp4a=${hasMp4a}).`,
    };
  }

  return { valid: true };
}

export async function transcodeToVerifiedMp4(opts: {
  rawBlob: Blob;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, statusLabel: string) => void;
}): Promise<Blob> {
  const { rawBlob, width, height, fps, durationSeconds, signal, onProgress } = opts;

  onProgress?.(90, 'Transcoding to H.264/AAC MP4 via server FFmpeg…');
  const headers = await getOperatorAuthHeaders({
    'Content-Type': rawBlob.type || 'application/octet-stream',
  });

  const url =
    `/api/video/transcode-mp4?width=${encodeURIComponent(String(width))}` +
    `&height=${encodeURIComponent(String(height))}` +
    `&fps=${encodeURIComponent(String(fps))}` +
    `&duration=${encodeURIComponent(String(Math.max(1, Math.ceil(durationSeconds))))}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: rawBlob,
    signal,
  });

  if (!res.ok) {
    let errorDetail = `HTTP ${res.status}`;
    const rawText = await res.text().catch(() => '');
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { error?: string };
        errorDetail = parsed.error || rawText;
      } catch {
        errorDetail = rawText;
      }
    }
    throw new Error(`MP4 conversion failed (${errorDetail}). Your original render has been preserved.`);
  }

  onProgress?.(96, 'Verifying MP4 atoms and H.264/AAC streams…');
  const buf = await res.arrayBuffer();
  const mp4Bytes = new Uint8Array(buf);
  const check = validateMp4ContainerBytes(mp4Bytes);
  if (!check.valid) {
    throw new Error(
      `MP4 verification failed (${check.reason || 'invalid container'}). Your original render has been preserved.`
    );
  }

  onProgress?.(100, 'Verified H.264 MP4 export ready');
  return new Blob([buf], { type: 'video/mp4' });
}

async function renderCanvasFallbackRaw(
  opts: RenderExportOptions & { width: number; height: number; fps: number }
): Promise<RawRenderBackup> {
  const { project, width, height, fps, signal, onProgress } = opts;
  const totalSec = project.scenes.reduce((acc, s) => acc + Math.max(1, s.durationSeconds), 0);
  const totalFrames = computeProjectDurationFrames(project, fps);
  const scaleUnit = Math.min(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable for fallback export.');
  }

  // Set up AudioContext mixing if narration or BGM data URL is present
  let audioCtx: AudioContext | null = null;
  let destNode: MediaStreamAudioDestinationNode | null = null;

  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass && (project.audio.narrationDataUrl || project.audio.bgmDataUrl)) {
      audioCtx = new AudioContextClass();
      destNode = audioCtx.createMediaStreamDestination();

      if (project.audio.narrationDataUrl) {
        const res = await fetch(project.audio.narrationDataUrl);
        const buf = await res.arrayBuffer();
        const audioBuf = await audioCtx.decodeAudioData(buf);
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuf;
        const gain = audioCtx.createGain();
        gain.gain.value = project.audio.narrationVolume ?? 1.0;
        src.connect(gain);
        gain.connect(destNode);
        src.start(audioCtx.currentTime);
      }

      if (project.audio.bgmDataUrl) {
        const res = await fetch(project.audio.bgmDataUrl);
        const buf = await res.arrayBuffer();
        const audioBuf = await audioCtx.decodeAudioData(buf);
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuf;
        src.loop = true;
        const gain = audioCtx.createGain();
        gain.gain.value = (project.audio.bgmVolume ?? 0.25) * 0.4;
        src.connect(gain);
        gain.connect(destNode);
        src.start(audioCtx.currentTime);
      }
    }
  } catch (audioErr) {
    console.warn('Audio decoding warning in canvas fallback:', audioErr);
  }

  const canvasStream = canvas.captureStream(fps);
  if (destNode && destNode.stream.getAudioTracks().length > 0) {
    const audioTrack = destNode.stream.getAudioTracks()[0];
    canvasStream.addTrack(audioTrack);
  }

  const mimeCandidate = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';

  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mimeCandidate,
    videoBitsPerSecond: 5_500_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const stopPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeCandidate }));
    recorder.onerror = () => reject(new Error('MediaRecorder encoding failed.'));
  });

  recorder.start(250);
  const frameIntervalMs = 1000 / fps;

  // Build cumulative scene boundaries
  let elapsed = 0;
  const timeline = project.scenes.map((sc) => {
    const startSec = elapsed;
    elapsed += Math.max(1, sc.durationSeconds);
    return { scene: sc, startSec, endSec: elapsed };
  });

  const renderStartWallClock = performance.now();

  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (signal?.aborted) {
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
      try {
        recorder.stop();
      } catch {
        // Ignore recorder stop error during cancellation
      }
      throw new Error('Render cancelled by user.');
    }

    const targetSec = frame / fps;
    const active =
      timeline.find((t) => targetSec >= t.startSec && targetSec < t.endSec) ||
      timeline[timeline.length - 1];
    const sc = active.scene;
    const sceneProgress = Math.min(
      1,
      Math.max(0, (targetSec - active.startSec) / Math.max(1, sc.durationSeconds))
    );

    // 1. Background Fill & Preset
    ctx.fillStyle = sc.motion.backgroundColor || '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Accent header top line
    const accent = sc.motion.accentColor || '#f59e0b';
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, width * (frame / Math.max(1, totalFrames)), 8);

    // 2. 2D Cartoon Environment or Motion Graphics elements
    if (sc.cartoon.enabled) {
      ctx.fillStyle = 'rgba(24, 24, 27, 0.45)';
      ctx.fillRect(width * 0.05, height * 0.35, width * 0.9, height * 0.42);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 4;
      ctx.strokeRect(width * 0.05, height * 0.35, width * 0.9, height * 0.42);

      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(scaleUnit * 0.032)}px sans-serif`;
      ctx.fillText(`[Studio: ${sc.cartoon.backgroundPreset}]`, width * 0.08, height * 0.41);
    }

    // 3. Stickman Silhouette / Presenter
    if (sc.stickman.enabled) {
      const sx = width * (sc.stickman.positionX / 100);
      const sy = height * (sc.stickman.positionY / 100);
      const bodyCol = sc.stickman.bodyColor || '#f4f4f5';

      ctx.save();
      ctx.translate(sx, sy);
      ctx.strokeStyle = bodyCol;
      ctx.lineWidth = Math.max(6, scaleUnit * 0.012);
      ctx.lineCap = 'round';

      // Head
      ctx.beginPath();
      ctx.arc(0, -scaleUnit * 0.12, scaleUnit * 0.05, 0, Math.PI * 2);
      ctx.fillStyle = bodyCol;
      ctx.fill();
      ctx.stroke();

      // Torso & Limbs
      ctx.beginPath();
      ctx.moveTo(0, -scaleUnit * 0.07);
      ctx.lineTo(0, scaleUnit * 0.06);
      ctx.moveTo(0, -scaleUnit * 0.03);
      ctx.lineTo(-scaleUnit * 0.09, scaleUnit * 0.02 + Math.sin(frame * 0.1) * 12);
      ctx.moveTo(0, -scaleUnit * 0.03);
      ctx.lineTo(scaleUnit * 0.09, scaleUnit * 0.02 - Math.sin(frame * 0.1) * 12);
      ctx.moveTo(0, scaleUnit * 0.06);
      ctx.lineTo(-scaleUnit * 0.05, scaleUnit * 0.18);
      ctx.moveTo(0, scaleUnit * 0.06);
      ctx.lineTo(scaleUnit * 0.05, scaleUnit * 0.18);
      ctx.stroke();
      ctx.restore();
    }

    // 4. Motion Graphics Headline & Subheadline
    ctx.fillStyle = '#a1a1aa';
    ctx.font = `600 ${Math.round(scaleUnit * 0.024)}px monospace`;
    ctx.fillText((sc.motion.kicker || 'BEHIND THE RELEASE').toUpperCase(), width * 0.07, height * 0.12);

    ctx.fillStyle = '#fafafa';
    ctx.font = `800 ${Math.round(scaleUnit * 0.052)}px sans-serif`;
    const headlineWords = sc.motion.headline.split(' ');
    let line = '';
    let textY = height * 0.2;
    for (const w of headlineWords) {
      const testLine = line ? `${line} ${w}` : w;
      if (ctx.measureText(testLine).width > width * 0.84) {
        ctx.fillText(line, width * 0.07, textY);
        line = w;
        textY += scaleUnit * 0.065;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, width * 0.07, textY);

    if (sc.motion.subheadline) {
      ctx.fillStyle = '#d4d4d8';
      ctx.font = `500 ${Math.round(scaleUnit * 0.032)}px sans-serif`;
      ctx.fillText(sc.motion.subheadline.slice(0, 60), width * 0.07, textY + scaleUnit * 0.06);
    }

    // 5. Subtitle Box with Word Highlighting
    const subText = sc.subtitleText || sc.narrationText || '';
    const subWords = subText.split(/\s+/).filter(Boolean);
    if (subWords.length > 0) {
      const activeWordIdx = Math.min(
        subWords.length - 1,
        Math.floor(sceneProgress * subWords.length)
      );

      const boxY = height * 0.78;
      ctx.fillStyle = 'rgba(9, 9, 11, 0.88)';
      ctx.fillRect(width * 0.06, boxY, width * 0.88, height * 0.13);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(width * 0.06, boxY, width * 0.88, height * 0.13);

      ctx.font = `700 ${Math.round(scaleUnit * 0.034)}px sans-serif`;
      let subX = width * 0.09;
      let subLineY = boxY + height * 0.075;
      for (let i = 0; i < subWords.length; i += 1) {
        const w = subWords[i];
        ctx.fillStyle =
          i === activeWordIdx
            ? project.captionStyle.highlightColor || '#f59e0b'
            : i < activeWordIdx
              ? '#e4e4e7'
              : '#a1a1aa';
        ctx.fillText(w + ' ', subX, subLineY);
        subX += ctx.measureText(w + ' ').width;
        if (subX > width * 0.84 && i < subWords.length - 1) {
          subX = width * 0.09;
          subLineY += scaleUnit * 0.045;
        }
      }
    }

    // 6. Watermark Footer
    if (project.captionStyle.showBrandWatermark) {
      ctx.fillStyle = 'rgba(244, 244, 245, 0.75)';
      ctx.font = `700 ${Math.round(scaleUnit * 0.022)}px monospace`;
      ctx.fillText('BEHIND THE RELEASE', width * 0.08, height * 0.96);
      ctx.textAlign = 'right';
      ctx.fillText(project.destination === 'youtube-shorts' ? 'SHORTS' : 'REELS', width * 0.92, height * 0.96);
      ctx.textAlign = 'left';
    }

    if (frame % Math.max(1, Math.round(fps / 2)) === 0) {
      onProgress?.(Math.round((frame / totalFrames) * 85), `Rendering canvas frame ${frame}/${totalFrames}…`);
    }

    // Wall-clock synchronization pacing
    const expectedElapsed = (frame + 1) * frameIntervalMs;
    const actualElapsed = performance.now() - renderStartWallClock;
    if (expectedElapsed > actualElapsed) {
      await new Promise((r) => setTimeout(r, expectedElapsed - actualElapsed));
    }
  }

  if (audioCtx && audioCtx.state !== 'closed') {
    try {
      audioCtx.close();
    } catch {
      // Ignore close error
    }
  }

  recorder.stop();
  const webmBlob = await stopPromise;
  return {
    blob: webmBlob,
    mimeType: webmBlob.type || mimeCandidate,
    width,
    height,
    durationSeconds: totalSec,
    fps,
  };
}

export async function renderVideoProjectToFile(
  opts: RenderExportOptions
): Promise<RenderExportResult> {
  const { project, resolution, signal, onProgress, onRawRenderBackup } = opts;
  const fps = opts.fps || 30;
  const { width, height } = resolveExportDimensions(resolution);
  const durationInFrames = computeProjectDurationFrames(project, fps);
  const totalSec = Number((durationInFrames / fps).toFixed(1));
  const hasAudio = Boolean(project.audio.narrationDataUrl || project.audio.bgmDataUrl);

  onProgress?.(2, 'Checking WebCodecs / Remotion renderer capabilities…');

  let rawBackup: RawRenderBackup | null = null;
  let engine: RenderExportResult['engine'] = 'canvas-ffmpeg-fallback';

  try {
    const mp4Check = await canRenderMediaOnWeb({
      width,
      height,
      container: 'mp4',
      muted: !hasAudio,
    });

    const targetContainer: 'mp4' | 'webm' = mp4Check.canRender ? 'mp4' : 'webm';
    const webmCheck = mp4Check.canRender
      ? mp4Check
      : await canRenderMediaOnWeb({
          width,
          height,
          container: 'webm',
          muted: !hasAudio,
        });

    if (webmCheck.canRender) {
      onProgress?.(5, `Rendering via Remotion Web Renderer (${targetContainer.toUpperCase()})…`);
      const { getBlob } = await renderMediaOnWeb<never, RemotionVideoProps>({
        composition: {
          id: `btr-video-${project.id}`,
          component: BehindTheReleaseVideoComposition,
          width,
          height,
          fps,
          durationInFrames,
          defaultProps: { project },
        },
        inputProps: { project },
        container: targetContainer,
        videoCodec: targetContainer === 'mp4' ? 'h264' : 'vp8',
        muted: !hasAudio,
        signal: signal ?? null,
        onProgress: (p) => {
          const pct = Math.min(86, Math.max(5, Math.round(p.progress * 86)));
          onProgress?.(pct, `Encoding ${p.encodedFrames}/${durationInFrames} frames…`);
        },
      });

      const rawBlob = await getBlob();
      engine = 'remotion-web';
      rawBackup = {
        blob: rawBlob,
        mimeType: targetContainer === 'mp4' ? 'video/mp4' : 'video/webm',
        width,
        height,
        durationSeconds: totalSec,
        fps,
      };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Remotion web renderer fell back to Canvas capture before MP4 transcode:', err);
  }

  if (!rawBackup) {
    rawBackup = await renderCanvasFallbackRaw({
      ...opts,
      width,
      height,
      fps,
    });
    engine = 'canvas-ffmpeg-fallback';
  }

  // Preserve original render before invoking server FFmpeg MP4 transcoding
  if (onRawRenderBackup) {
    await onRawRenderBackup(rawBackup);
  }

  const mp4Blob = await transcodeToVerifiedMp4({
    rawBlob: rawBackup.blob,
    width: rawBackup.width,
    height: rawBackup.height,
    fps: rawBackup.fps,
    durationSeconds: rawBackup.durationSeconds,
    signal,
    onProgress,
  });

  return {
    blob: mp4Blob,
    format: 'mp4',
    mimeType: 'video/mp4',
    engine,
    durationSeconds: totalSec,
    width,
    height,
  };
}
