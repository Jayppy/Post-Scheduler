import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import {
  EditingPreset,
  ReelAssetRef,
  ReelState,
  SubtitleSegment,
  TimelineClip,
  Workspace,
} from '../types/studio';
import { getMediaBlob } from './idb';

export interface ReelValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalDuration: number;
}

export function validateReelForPlatform(reel: ReelState): ReelValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const totalDuration = reel.timelineClips.reduce((acc, clip) => acc + Math.max(0.5, clip.duration), 0);

  if (reel.timelineClips.length === 0) {
    errors.push('Timeline has no clips. Add at least one clip, image, or typography card.');
  }

  if (totalDuration <= 0.5) {
    errors.push('Video duration must be at least 1 second.');
  }

  if (totalDuration > 60) {
    errors.push(`Total duration (${totalDuration.toFixed(1)}s) exceeds the 60-second maximum.`);
  }

  if (reel.destinationProfile === 'instagram-reels') {
    if (totalDuration < 3) {
      warnings.push('Instagram Reels perform best when duration is at least 3 seconds.');
    }
    if (reel.subtitles.length === 0 && reel.timelineClips.every((c) => !c.textOverlay.trim())) {
      warnings.push('No captions or text overlays detected for silent Instagram Reels viewers.');
    }
  } else if (reel.destinationProfile === 'youtube-shorts') {
    if (totalDuration > 59.5) {
      warnings.push('YouTube Shorts recommends staying strictly under 60.0s to avoid standard VOD classification.');
    }
    if (!reel.hookLine.trim()) {
      warnings.push('Consider adding an opening hook or title overlay for YouTube Shorts retention.');
    }
  }

  const totalBytes = reel.assets.reduce((acc, a) => acc + (a.sizeBytes || 0), 0);
  if (totalBytes > 120 * 1024 * 1024) {
    warnings.push('Large media assets (>120 MB) detected. Browser rendering may take longer on lower-memory devices.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    totalDuration,
  };
}

export function getColorFilterCss(treatment: EditingPreset['colorTreatment']): string {
  switch (treatment) {
    case 'obsidian-silver':
      return 'contrast(1.12) saturate(0.75) brightness(0.96)';
    case 'warm-analog':
      return 'contrast(1.06) sepia(0.18) saturate(1.08)';
    case 'high-contrast-mono':
      return 'grayscale(1) contrast(1.25) brightness(0.98)';
    case 'cinematic-teal':
      return 'contrast(1.1) saturate(0.92) hue-rotate(-6deg)';
    case 'clean-editorial':
    default:
      return 'contrast(1.04) saturate(1.02)';
  }
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface RenderReelContext {
  reel: ReelState;
  workspace: Workspace;
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (stage: string, pct: number) => void;
  abortSignal?: AbortSignal;
}

export interface RenderReelOutput {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  engineUsed: 'ffmpeg-wasm' | 'canvas-mediarecorder';
  duration: number;
  width: number;
  height: number;
  fps: number;
}

let cachedFfmpeg: FFmpeg | null = null;

async function getLoadedFfmpeg(onLog?: (msg: string) => void): Promise<FFmpeg | null> {
  try {
    if (cachedFfmpeg && cachedFfmpeg.loaded) {
      return cachedFfmpeg;
    }
    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on('log', ({ message }) => onLog(message));
    }
    await ffmpeg.load({
      coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
      wasmURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
    });
    cachedFfmpeg = ffmpeg;
    return ffmpeg;
  } catch (err) {
    console.warn('FFmpeg.wasm unavailable or failed to initialize, using browser Canvas MediaRecorder:', err);
    return null;
  }
}

export function drawReelFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  elapsed: number,
  totalDuration: number,
  reel: ReelState,
  workspace: Workspace,
  mediaMap: Map<string, HTMLVideoElement | HTMLImageElement>
) {
  ctx.save();
  ctx.fillStyle = '#09090b';
  ctx.fillRect(0, 0, width, height);

  // Locate active clip & clip local time
  let cursor = 0;
  let activeClip: TimelineClip | null = null;
  let clipLocalTime = 0;
  for (const clip of reel.timelineClips) {
    if (elapsed >= cursor && elapsed < cursor + clip.duration) {
      activeClip = clip;
      clipLocalTime = elapsed - cursor;
      break;
    }
    cursor += clip.duration;
  }
  if (!activeClip && reel.timelineClips.length > 0) {
    activeClip = reel.timelineClips[reel.timelineClips.length - 1];
    clipLocalTime = activeClip.duration;
  }

  if (activeClip) {
    const mediaEl = mediaMap.get(activeClip.assetId);
    const transitionDur = Math.min(0.45, activeClip.duration * 0.25);
    let transitionOpacity = 1;
    let offsetY = 0;
    let extraScale = 1;

    if (clipLocalTime < transitionDur) {
      const t = clipLocalTime / transitionDur;
      if (activeClip.transition === 'crossfade') {
        transitionOpacity = t;
      } else if (activeClip.transition === 'slide-up') {
        offsetY = (1 - t) * 48;
        transitionOpacity = 0.2 + 0.8 * t;
      } else if (activeClip.transition === 'zoom-punch') {
        extraScale = 1.12 - 0.12 * t;
      } else if (activeClip.transition === 'flash-silver') {
        transitionOpacity = t;
      }
    }

    ctx.save();
    ctx.globalAlpha = transitionOpacity;
    ctx.filter = getColorFilterCss(reel.colorTreatment);

    if (mediaEl) {
      const naturalW =
        mediaEl instanceof HTMLVideoElement ? mediaEl.videoWidth || width : mediaEl.naturalWidth || width;
      const naturalH =
        mediaEl instanceof HTMLVideoElement ? mediaEl.videoHeight || height : mediaEl.naturalHeight || height;

      const scaleCover = Math.max(width / naturalW, height / naturalH) * (activeClip.zoom || 1) * extraScale;
      const drawW = naturalW * scaleCover;
      const drawH = naturalH * scaleCover;
      const shiftX = ((activeClip.cropX || 0) / 100) * (drawW - width);
      const shiftY = ((activeClip.cropY || 0) / 100) * (drawH - height);
      const drawX = (width - drawW) / 2 - shiftX;
      const drawY = (height - drawH) / 2 - shiftY + offsetY;

      ctx.drawImage(mediaEl, drawX, drawY, drawW, drawH);
    } else {
      // Typography card backdrop
      ctx.fillStyle = activeClip.bgColor || '#111115';
      ctx.fillRect(0, 0, width, height);
      const grad = ctx.createRadialGradient(width / 2, height * 0.35, 40, width / 2, height * 0.5, width);
      grad.addColorStop(0, 'rgba(228,228,231,0.12)');
      grad.addColorStop(1, 'rgba(9,9,11,0.95)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();

    // Contrast scrim for text legibility
    const scrim = ctx.createLinearGradient(0, 0, 0, height);
    scrim.addColorStop(0, 'rgba(0,0,0,0.48)');
    scrim.addColorStop(0.45, 'rgba(0,0,0,0.18)');
    scrim.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, width, height);

    // Flash transition peak
    if (activeClip.transition === 'flash-silver' && clipLocalTime < 0.14) {
      ctx.fillStyle = `rgba(244,244,245,${(1 - clipLocalTime / 0.14) * 0.35})`;
      ctx.fillRect(0, 0, width, height);
    }

    // Motion Text Overlay
    if (activeClip.textOverlay.trim()) {
      ctx.save();
      const appear = Math.min(1, clipLocalTime / 0.35);
      ctx.globalAlpha = appear;
      const fontSize = Math.round(width * 0.058);
      ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = wrapCanvasText(ctx, activeClip.textOverlay, width * 0.82);
      const lineH = fontSize * 1.2;
      const startY =
        activeClip.kind === 'typography-card'
          ? height * 0.45 - ((lines.length - 1) * lineH) / 2
          : height * 0.25 - ((lines.length - 1) * lineH) / 2;

      lines.forEach((line, i) => {
        const y = startY + i * lineH + (1 - appear) * 18;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(line, width / 2 + 2, y + 3);
        ctx.fillStyle = '#fafafa';
        ctx.fillText(line, width / 2, y);
      });
      ctx.restore();
    }

    // Lower Third
    if (activeClip.lowerThird.trim()) {
      ctx.save();
      const boxW = Math.min(width * 0.78, 760);
      const boxH = Math.round(height * 0.055);
      const bx = Math.round(width * 0.08);
      const by = Math.round(height * 0.72);
      ctx.fillStyle = 'rgba(17, 17, 20, 0.86)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = 'rgba(228, 228, 231, 0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, boxW, boxH);
      ctx.font = `600 ${Math.round(width * 0.028)}px "Manrope", sans-serif`;
      ctx.fillStyle = '#f4f4f5';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(activeClip.lowerThird, bx + 22, by + boxH / 2, boxW - 44);
      ctx.restore();
    }
  }

  // Intro template (first 1.6s)
  if (reel.introTemplate !== 'none' && elapsed < 1.6) {
    const fade = elapsed > 1.2 ? 1 - (elapsed - 1.2) / 0.4 : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = reel.introTemplate === 'studio-slate' ? 'rgba(9,9,11,0.72)' : 'rgba(9,9,11,0.45)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 2;
    ctx.strokeRect(width * 0.08, height * 0.08, width * 0.84, height * 0.84);
    ctx.font = `600 ${Math.round(width * 0.026)}px "JetBrains Mono", monospace`;
    ctx.fillStyle = '#d4d4d8';
    ctx.textAlign = 'center';
    ctx.fillText(workspace.name.toUpperCase(), width / 2, height * 0.16);
    ctx.restore();
  }

  // Outro template (last 2.0s)
  if (reel.outroTemplate !== 'none' && totalDuration > 2.5 && elapsed > totalDuration - 2.0) {
    const t = Math.min(1, (elapsed - (totalDuration - 2.0)) / 0.4);
    ctx.save();
    ctx.globalAlpha = t;
    ctx.fillStyle = 'rgba(9, 9, 11, 0.86)';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(width * 0.05)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#fafafa';
    ctx.fillText(workspace.name, width / 2, height * 0.45);
    ctx.font = `400 ${Math.round(width * 0.028)}px "Manrope", sans-serif`;
    ctx.fillStyle = '#a1a1aa';
    const outroLines = wrapCanvasText(
      ctx,
      reel.closingCta || workspace.defaultOutroText,
      width * 0.76
    );
    outroLines.forEach((line, idx) => {
      ctx.fillText(line, width / 2, height * 0.53 + idx * width * 0.042);
    });
    ctx.restore();
  }

  // Brand logo/watermark
  if (reel.showBrandLogo) {
    ctx.save();
    ctx.font = `600 ${Math.round(width * 0.024)}px "JetBrains Mono", monospace`;
    ctx.fillStyle = 'rgba(244, 244, 245, 0.78)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(workspace.watermarkText || workspace.name.toUpperCase(), width * 0.06, height * 0.045);
    ctx.restore();
  }

  // Top progress indicator bar
  if (reel.showProgressBar && totalDuration > 0) {
    const pct = Math.min(1, Math.max(0, elapsed / totalDuration));
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(0, 0, width, Math.max(4, Math.round(height * 0.005)));
    ctx.fillStyle = '#e4e4e7';
    ctx.fillRect(0, 0, width * pct, Math.max(4, Math.round(height * 0.005)));
  }

  // Animated Subtitles
  const activeSub: SubtitleSegment | undefined = reel.subtitles.find(
    (s) => elapsed >= s.startTime && elapsed <= s.endTime
  );
  if (activeSub && activeSub.text.trim()) {
    ctx.save();
    const scaleFactor = width / 1080;
    const fSize = Math.round(reel.subtitleSettings.fontSize * scaleFactor);
    ctx.font = `700 ${fSize}px "${reel.subtitleSettings.fontFamily}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const subLines = wrapCanvasText(ctx, activeSub.text, width * 0.84);
    const subYBase =
      reel.subtitleSettings.position === 'top'
        ? height * 0.16
        : reel.subtitleSettings.position === 'center'
          ? height * 0.54
          : height * 0.82;

    const lineH = fSize * 1.32;
    if (reel.subtitleSettings.animationPreset === 'bold-box') {
      const boxH = subLines.length * lineH + 24 * scaleFactor;
      const boxW = width * 0.88;
      ctx.fillStyle = 'rgba(9, 9, 11, 0.85)';
      ctx.fillRect((width - boxW) / 2, subYBase - lineH / 2 - 12 * scaleFactor, boxW, boxH);
    }

    subLines.forEach((line, i) => {
      const ly = subYBase + i * lineH;
      const hl = activeSub.highlightWord.trim();
      if (hl && line.toLowerCase().includes(hl.toLowerCase())) {
        // Render word highlight cleanly
        const words = line.split(' ');
        const totalW = ctx.measureText(line).width;
        let wx = width / 2 - totalW / 2;
        ctx.textAlign = 'left';
        for (const word of words) {
          const isMatch = word.toLowerCase().replace(/[^a-z0-9]/g, '') === hl.toLowerCase().replace(/[^a-z0-9]/g, '');
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.fillText(word, wx + 2, ly + 2);
          ctx.fillStyle = isMatch ? reel.subtitleSettings.highlightColor || '#f59e0b' : '#ffffff';
          ctx.fillText(word, wx, ly);
          wx += ctx.measureText(`${word} `).width;
        }
      } else {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillText(line, width / 2 + 2, ly + 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, width / 2, ly);
      }
    });
    ctx.restore();
  }

  ctx.restore();
}

export async function renderReelVideo({
  reel,
  workspace,
  width = 1080,
  height = 1920,
  fps = 30,
  onProgress,
  abortSignal,
}: RenderReelContext): Promise<RenderReelOutput> {
  const validation = validateReelForPlatform(reel);
  if (!validation.valid) {
    throw new Error(validation.errors[0]);
  }

  const totalDuration = validation.totalDuration;
  onProgress?.('Loading media assets from local vault...', 5);

  const objectUrls: string[] = [];
  const mediaMap = new Map<string, HTMLVideoElement | HTMLImageElement>();
  let audioBuffer: AudioBuffer | null = null;
  let voiceBuffer: AudioBuffer | null = null;

  const audioCtx = new AudioContext();

  try {
    // Load visual assets
    for (const asset of reel.assets) {
      if (abortSignal?.aborted) throw new Error('Export cancelled.');
      const blob = await getMediaBlob(asset.blobKey);
      if (!blob) continue;

      if (asset.kind === 'image') {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const img = await new Promise<HTMLImageElement | null>((resolve) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => resolve(null);
          el.src = url;
        });
        if (img) mediaMap.set(asset.id, img);
      } else if (asset.kind === 'video') {
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const vid = await new Promise<HTMLVideoElement | null>((resolve) => {
          const el = document.createElement('video');
          el.muted = true;
          el.playsInline = true;
          el.preload = 'auto';
          el.onloadeddata = () => resolve(el);
          el.onerror = () => resolve(null);
          el.src = url;
        });
        if (vid) mediaMap.set(asset.id, vid);
      } else if (asset.kind === 'audio' && asset.id === reel.audioTrackAssetId) {
        const buf = await blob.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(buf.slice(0));
      } else if (asset.kind === 'voice' && asset.id === reel.voiceTrackAssetId) {
        const buf = await blob.arrayBuffer();
        voiceBuffer = await audioCtx.decodeAudioData(buf.slice(0));
      }
    }

    onProgress?.('Initializing vertical 9:16 compositor...', 15);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize video canvas.');

    const stream = canvas.captureStream(fps);
    const dest = audioCtx.createMediaStreamDestination();

    const attachAudioBuffer = (buffer: AudioBuffer, gainLevel: number) => {
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gain = audioCtx.createGain();
      const now = audioCtx.currentTime;
      const fadeIn = Math.min(reel.audioFadeIn, totalDuration * 0.4);
      const fadeOut = Math.min(reel.audioFadeOut, totalDuration * 0.4);

      if (fadeIn > 0.05) {
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(gainLevel, now + fadeIn);
      } else {
        gain.gain.setValueAtTime(gainLevel, now);
      }

      if (fadeOut > 0.05 && totalDuration > fadeOut) {
        gain.gain.setValueAtTime(gainLevel, now + totalDuration - fadeOut);
        gain.gain.linearRampToValueAtTime(0.001, now + totalDuration);
      }

      source.connect(gain);
      gain.connect(dest);
      source.start(now, 0, totalDuration);
    };

    if (audioBuffer) {
      attachAudioBuffer(audioBuffer, reel.musicVolume);
    }
    if (voiceBuffer) {
      attachAudioBuffer(voiceBuffer, reel.voiceVolume);
    }

    if (audioBuffer || voiceBuffer) {
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }

    const preferredMimes = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const selectedMime =
      preferredMimes.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';

    if (!selectedMime) {
      throw new Error('This browser does not support MediaRecorder video encoding.');
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: selectedMime,
      videoBitsPerSecond: 6_000_000,
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const recordingComplete = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: selectedMime }));
      recorder.onerror = () => reject(new Error('MediaRecorder encoding failed.'));
    });

    recorder.start(250);
    onProgress?.('Rendering vertical timeline frames...', 20);

    const startTime = performance.now();
    let lastStartedClipId: string | null = null;

    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (abortSignal?.aborted) {
          recorder.stop();
          reject(new Error('Export cancelled by user.'));
          return;
        }
        const elapsed = (performance.now() - startTime) / 1000;
        if (elapsed >= totalDuration) {
          drawReelFrame(ctx, width, height, totalDuration - 0.01, totalDuration, reel, workspace, mediaMap);
          resolve();
          return;
        }

        // Sync active video element playhead when entering a video clip
        let cursor = 0;
        for (const clip of reel.timelineClips) {
          if (elapsed >= cursor && elapsed < cursor + clip.duration) {
            if (lastStartedClipId !== clip.id) {
              lastStartedClipId = clip.id;
              const el = mediaMap.get(clip.assetId);
              if (el instanceof HTMLVideoElement) {
                el.currentTime = clip.trimStart || 0;
                el.play().catch(() => {});
              }
            }
            break;
          }
          cursor += clip.duration;
        }

        drawReelFrame(ctx, width, height, elapsed, totalDuration, reel, workspace, mediaMap);
        const pct = 20 + Math.round((elapsed / totalDuration) * 55);
        onProgress?.(`Rendering frames (${elapsed.toFixed(1)}s / ${totalDuration.toFixed(1)}s)...`, pct);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    recorder.stop();
    const rawBlob = await recordingComplete;

    // Pause any playing video elements
    mediaMap.forEach((el) => {
      if (el instanceof HTMLVideoElement) {
        el.pause();
      }
    });

    if (selectedMime.startsWith('video/mp4')) {
      onProgress?.('Finalizing MP4 container...', 100);
      return {
        blob: rawBlob,
        mimeType: 'video/mp4',
        extension: 'mp4',
        engineUsed: 'canvas-mediarecorder',
        duration: totalDuration,
        width,
        height,
        fps,
      };
    }

    // Attempt FFmpeg.wasm transcoding to H.264/AAC MP4
    onProgress?.('Transcoding to MP4 (H.264/AAC) with FFmpeg.wasm...', 80);
    const ffmpeg = await getLoadedFfmpeg();
    if (ffmpeg) {
      try {
        await ffmpeg.writeFile('input.webm', await fetchFile(rawBlob));
        await ffmpeg.exec([
          '-i',
          'input.webm',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-r',
          String(fps),
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          'output.mp4',
        ]);
        const mp4Data = await ffmpeg.readFile('output.mp4');
        const mp4Bytes = mp4Data instanceof Uint8Array ? new Uint8Array(mp4Data) : new TextEncoder().encode(String(mp4Data));
        const mp4Blob = new Blob([mp4Bytes.buffer], { type: 'video/mp4' });
        await ffmpeg.deleteFile('input.webm').catch(() => {});
        await ffmpeg.deleteFile('output.mp4').catch(() => {});
        onProgress?.('MP4 export ready.', 100);
        return {
          blob: mp4Blob,
          mimeType: 'video/mp4',
          extension: 'mp4',
          engineUsed: 'ffmpeg-wasm',
          duration: totalDuration,
          width,
          height,
          fps,
        };
      } catch (ffmpegErr) {
        console.warn('FFmpeg.wasm transcode failed, returning WebM fallback:', ffmpegErr);
      }
    }

    onProgress?.('Export complete (WebM fallback container).', 100);
    return {
      blob: rawBlob,
      mimeType: rawBlob.type || 'video/webm',
      extension: 'webm',
      engineUsed: 'canvas-mediarecorder',
      duration: totalDuration,
      width,
      height,
      fps,
    };
  } finally {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    await audioCtx.close().catch(() => {});
  }
}

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function parseSrtOrTranscript(raw: string, totalDuration = 30): SubtitleSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Check SRT timestamp pattern: 00:00:01,000 --> 00:00:03,500
  const srtRegex = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\n\d+\s*\n|$)/g;
  const srtMatches = Array.from(trimmed.matchAll(srtRegex));

  if (srtMatches.length > 0) {
    return srtMatches.map((m, idx) => {
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      const text = m[9].replace(/\n/g, ' ').trim();
      const words = text.split(' ');
      return {
        id: `sub-${Date.now()}-${idx}`,
        startTime: start,
        endTime: Math.max(start + 0.8, end),
        text,
        highlightWord: words.length > 2 ? words[Math.floor(words.length / 2)] : '',
      };
    });
  }

  // Plain text lines distributed evenly across duration
  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segDur = Math.max(1.5, totalDuration / Math.max(1, lines.length));
  return lines.map((text, idx) => {
    const startTime = Number((idx * segDur).toFixed(2));
    const endTime = Number(((idx + 1) * segDur).toFixed(2));
    const words = text.split(' ');
    return {
      id: `sub-${Date.now()}-${idx}`,
      startTime,
      endTime,
      text,
      highlightWord: words.length > 2 ? words[words.length - 1].replace(/[^a-zA-Z0-9]/g, '') : '',
    };
  });
}
