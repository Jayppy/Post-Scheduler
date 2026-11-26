import React from 'react';
import { AbsoluteFill, Audio, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoProject, VideoScene } from '../../types/videoStudio';
import { StickmanSvg } from './StickmanSvg';
import { CartoonAssetLibrary } from './CartoonAssetLibrary';
import { MotionGraphicsLayer } from './MotionGraphicsLayer';

export type RemotionVideoProps = {
  project: VideoProject;
};

const SceneRenderer: React.FC<{
  scene: VideoScene;
  captionStyle: VideoProject['captionStyle'];
}> = ({ scene, captionStyle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words = (scene.subtitleText || scene.narrationText || '').split(/\s+/).filter(Boolean);
  const sceneFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
  const activeWordIdx = Math.min(
    words.length - 1,
    Math.floor((frame / sceneFrames) * words.length)
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: scene.motion.backgroundColor || '#09090b',
        overflow: 'hidden',
      }}
    >
      {/* Background 2D Cartoon Scene Layer */}
      <CartoonAssetLibrary config={scene.cartoon} frame={frame} fps={fps} />

      {/* Custom User Image Layer when assigned per scene */}
      {scene.customOverlayAssetUrl && (
        <img
          src={scene.customOverlayAssetUrl}
          alt={scene.title}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: scene.customOverlayOpacity ?? 0.25,
          }}
        />
      )}

      {/* Contrast Scrim for Crisp Typography */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(9,9,11,0.78) 0%, rgba(9,9,11,0.38) 45%, rgba(9,9,11,0.88) 100%)',
        }}
      />

      {/* Stickman Character Animation Engine */}
      <StickmanSvg config={scene.stickman} frame={frame} fps={fps} />

      {/* Motion Graphics & Kinetic Typography */}
      <MotionGraphicsLayer config={scene.motion} frame={frame} fps={fps} />

      {/* Synchronized Word-Highlight Subtitles */}
      {words.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 56,
            right: 56,
            bottom:
              captionStyle.position === 'top'
                ? undefined
                : captionStyle.position === 'center'
                  ? '42%'
                  : 130,
            top: captionStyle.position === 'top' ? 140 : undefined,
            textAlign: 'center',
            padding: '20px 28px',
            borderRadius: 18,
            backgroundColor: 'rgba(9, 9, 11, 0.84)',
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <p
            style={{
              margin: 0,
              fontFamily: 'Plus Jakarta Sans, sans-serif',
              fontSize: captionStyle.fontSize || 42,
              lineHeight: 1.28,
              fontWeight: 700,
              color: '#fafafa',
            }}
          >
            {words.map((w, idx) => (
              <span
                key={`${w}-${idx}`}
                style={{
                  color:
                    idx === activeWordIdx
                      ? captionStyle.highlightColor || '#f59e0b'
                      : idx < activeWordIdx
                        ? '#e4e4e7'
                        : '#a1a1aa',
                  marginRight: '0.25em',
                  display: 'inline-block',
                }}
              >
                {w}
              </span>
            ))}
          </p>
        </div>
      )}
    </AbsoluteFill>
  );
};

export const BehindTheReleaseVideoComposition: React.FC<RemotionVideoProps> = ({ project }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  let cursorFrame = 0;
  const sequenceOffsets = project.scenes.map((scene) => {
    const start = cursorFrame;
    const durFrames = Math.max(15, Math.round(scene.durationSeconds * fps));
    cursorFrame += durFrames;
    return { scene, start, durFrames };
  });

  const progressPct = Math.min(100, Math.max(0, (frame / Math.max(1, durationInFrames)) * 100));

  return (
    <AbsoluteFill style={{ backgroundColor: '#09090b', color: '#fafafa' }}>
      {sequenceOffsets.map(({ scene, start, durFrames }) => (
        <Sequence key={scene.id} from={start} durationInFrames={durFrames}>
          <SceneRenderer scene={scene} captionStyle={project.captionStyle} />
        </Sequence>
      ))}

      {/* Optional Narration & Background Music Audio Tracks */}
      {project.audio.narrationDataUrl && (
        <Audio src={project.audio.narrationDataUrl} volume={project.audio.narrationVolume} />
      )}
      {project.audio.bgmDataUrl && (
        <Audio src={project.audio.bgmDataUrl} volume={project.audio.bgmVolume} />
      )}

      {/* Top Reel Progress Bar */}
      {project.captionStyle.showProgressBar && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            left: 48,
            right: 48,
            height: 8,
            borderRadius: 99,
            backgroundColor: 'rgba(255,255,255,0.16)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progressPct}%`,
              height: '100%',
              backgroundColor: project.captionStyle.highlightColor || '#f59e0b',
            }}
          />
        </div>
      )}

      {/* Brand Identity Watermark */}
      {project.captionStyle.showBrandWatermark && (
        <div
          style={{
            position: 'absolute',
            bottom: 48,
            left: 56,
            right: 56,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 22,
            letterSpacing: '0.14em',
            color: 'rgba(244, 244, 245, 0.72)',
          }}
        >
          <span>BEHIND THE RELEASE</span>
          <span>{project.destination === 'youtube-shorts' ? 'SHORTS' : 'REELS'}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};
