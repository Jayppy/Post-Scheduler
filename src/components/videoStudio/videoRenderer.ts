import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import type { VideoProject } from '../../types/videoStudio';
import {
  BehindTheReleaseVideoComposition,
  type RemotionVideoProps,
} from './RemotionComposition';
import { getOperatorAuthHeaders } from '../../services/authHeaders';

export interface RenderExportOptions {
  project: VideoProject;
  resolution: '1080x1920' | '540x960';
  fps?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number, statusLabel: string) => void;
}

export interface RenderExportResult {
  blob: Blob;
  format: 'mp4' | 'webm';
  mimeType: string;
  engine: 'remotion-web' | 'canvas-ffmpeg-fallback';
  durationSeconds: number;
  width: number;
  height: number;
}

export function computeProjectDurationFrames(project: VideoProject, fps: number): number {
  const totalSec = project.scenes.reduce((acc, s) => acc + Math.max(1, s.durationSeconds), 0);
  return Math.max(fps * 2, Math.round(totalSec * fps));
}

async function renderCanvasFallbackVideo(
  opts: RenderExportOptions & { width: number; height: number; fps: number }
): Promise<RenderExportResult> {
  const { project, width, height, fps, signal, onProgress } = opts;
  const totalSec = project.scenes.reduce((acc, s) => acc + Math.max(1, s.durationSeconds), 0);
  const totalFrames = computeProjectDurationFrames(project, fps);

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
  let sourceNode: AudioNode | null = null;
  let bgmSourceNode: AudioNode | null = null;

  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
        sourceNode = src;
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
        bgmSourceNode = src;
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
      try { recorder.stop(); } catch {}
      throw new Error('Render cancelled by user.');
    }

    const targetSec = frame / fps;
    const active =
      timeline.find((t) => targetSec >= t.startSec && targetSec < t.endSec) ||
      timeline[timeline.length - 1];
    const sc = active.scene;
    const sceneProgress = Math.min(1, Math.max(0, (targetSec - active.startSec) / Math.max(1, sc.durationSeconds)));

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

      // Draw props representation
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(width * 0.032)}px sans-serif`;
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
      ctx.lineWidth = Math.max(6, width * 0.012);
      ctx.lineCap = 'round';

      // Head
      ctx.beginPath();
      ctx.arc(0, -width * 0.12, width * 0.05, 0, Math.PI * 2);
      ctx.fillStyle = bodyCol;
      ctx.fill();
      ctx.stroke();

      // Torso & Limbs
      ctx.beginPath();
      ctx.moveTo(0, -width * 0.07);
      ctx.lineTo(0, width * 0.06);
      ctx.moveTo(0, -width * 0.03);
      ctx.lineTo(-width * 0.09, width * 0.02 + Math.sin(frame * 0.1) * 12);
      ctx.moveTo(0, -width * 0.03);
      ctx.lineTo(width * 0.09, width * 0.02 - Math.sin(frame * 0.1) * 12);
      ctx.moveTo(0, width * 0.06);
      ctx.lineTo(-width * 0.05, width * 0.18);
      ctx.moveTo(0, width * 0.06);
      ctx.lineTo(width * 0.05, width * 0.18);
      ctx.stroke();
      ctx.restore();
    }

    // 4. Motion Graphics Headline & Subheadline
    ctx.fillStyle = '#a1a1aa';
    ctx.font = `600 ${Math.round(width * 0.024)}px monospace`;
    ctx.fillText((sc.motion.kicker || 'BEHIND THE RELEASE').toUpperCase(), width * 0.07, height * 0.12);

    ctx.fillStyle = '#fafafa';
    ctx.font = `800 ${Math.round(width * 0.052)}px sans-serif`;
    const headlineWords = sc.motion.headline.split(' ');
    let line = '';
    let textY = height * 0.20;
    for (const w of headlineWords) {
      const testLine = line ? `${line} ${w}` : w;
      if (ctx.measureText(testLine).width > width * 0.84) {
        ctx.fillText(line, width * 0.07, textY);
        line = w;
        textY += width * 0.065;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, width * 0.07, textY);

    if (sc.motion.subheadline) {
      ctx.fillStyle = '#d4d4d8';
      ctx.font = `500 ${Math.round(width * 0.032)}px sans-serif`;
      ctx.fillText(sc.motion.subheadline.slice(0, 60), width * 0.07, textY + width * 0.06);
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

      ctx.font = `700 ${Math.round(width * 0.034)}px sans-serif`;
      let subX = width * 0.09;
      let subLineY = boxY + height * 0.075;
      for (let i = 0; i < subWords.length; i++) {
        const w = subWords[i];
        ctx.fillStyle = i === activeWordIdx ? (project.captionStyle.highlightColor || '#f59e0b') : i < activeWordIdx ? '#e4e4e7' : '#a1a1aa';
        ctx.fillText(w + ' ', subX, subLineY);
        subX += ctx.measureText(w + ' ').width;
        if (subX > width * 0.84 && i < subWords.length - 1) {
          subX = width * 0.09;
          subLineY += width * 0.045;
        }
      }
    }

    // 6. Watermark Footer
    if (project.captionStyle.showBrandWatermark) {
      ctx.fillStyle = 'rgba(244, 244, 245, 0.75)';
      ctx.font = `700 ${Math.round(width * 0.022)}px monospace`;
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
    try { audioCtx.close(); } catch {}
  }

  recorder.stop();
  const webmBlob = await stopPromise;

  // Attempt server FFmpeg transcoding into social-ready H.264 MP4 with operator auth headers
  onProgress?.(90, 'Transcoding to H.264 MP4 via server FFmpeg…');
  try {
    const headers = await getOperatorAuthHeaders({ 'Content-Type': 'application/octet-stream' });
    const res = await fetch(
      `/api/video/transcode-mp4?width=${width}&height=${height}&fps=${fps}&duration=${Math.ceil(totalSec)}`,
      {
        method: 'POST',
        headers,
        body: webmBlob,
        signal,
      }
    );
    if (res.ok) {
      const mp4Blob = await res.blob();
      onProgress?.(100, 'MP4 export ready');
      return {
        blob: mp4Blob,
        format: 'mp4',
        mimeType: 'video/mp4',
        engine: 'canvas-ffmpeg-fallback',
        durationSeconds: totalSec,
        width,
        height,
      };
    }
  } catch {
    // Return WebM cleanly if server transcoding fails
  }

  onProgress?.(100, 'WebM export ready');
  return {
    blob: webmBlob,
    format: 'webm',
    mimeType: 'video/webm',
    engine: 'canvas-ffmpeg-fallback',
    durationSeconds: totalSec,
    width,
    height,
  };
}

export async function renderVideoProjectToFile(
  opts: RenderExportOptions
): Promise<RenderExportResult> {
  const { project, resolution, signal, onProgress } = opts;
  const fps = opts.fps || 30;
  const width = resolution === '540x960' ? 540 : 1080;
  const height = resolution === '540x960' ? 960 : 1920;
  const durationInFrames = computeProjectDurationFrames(project, fps);
  const totalSec = Number((durationInFrames / fps).toFixed(1));
  const hasAudio = Boolean(project.audio.narrationDataUrl || project.audio.bgmDataUrl);

  onProgress?.(2, 'Checking WebCodecs / Remotion renderer capabilities…');

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
          const pct = Math.min(99, Math.max(5, Math.round(p.progress * 100)));
          onProgress?.(pct, `Encoding ${p.encodedFrames}/${durationInFrames} frames…`);
        },
      });

      const rawBlob = await getBlob();
      onProgress?.(100, 'Remotion render complete');
      return {
        blob: rawBlob,
        format: targetContainer,
        mimeType: targetContainer === 'mp4' ? 'video/mp4' : 'video/webm',
        engine: 'remotion-web',
        durationSeconds: totalSec,
        width,
        height,
      };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Remotion web renderer fell back to Canvas+FFmpeg:', err);
  }

  return renderCanvasFallbackVideo({
    ...opts,
    width,
    height,
    fps,
  });
}

