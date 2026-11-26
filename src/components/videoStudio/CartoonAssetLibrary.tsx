import React from 'react';
import type { CartoonSceneConfig } from '../../types/videoStudio';

interface CartoonAssetLibraryProps {
  config: CartoonSceneConfig;
  frame: number;
  fps: number;
}

export const CartoonAssetLibrary: React.FC<CartoonAssetLibraryProps> = ({
  config,
  frame,
  fps,
}) => {
  if (!config.enabled) return null;

  const t = frame / Math.max(1, fps);
  const floatY = Math.sin(t * 2.2) * 8;
  const barPulse = (idx: number) => 16 + Math.abs(Math.sin(t * 6 + idx * 0.7)) * 42;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Stylized 2D Environment Backdrop */}
      <svg
        width="1080"
        height="1920"
        viewBox="0 0 1080 1920"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <defs>
          <radialGradient id="stageGlow" cx="50%" cy="35%" r="55%">
            <stop offset="0%" stopColor={config.accentColor} stopOpacity="0.24" />
            <stop offset="100%" stopColor="#09090b" stopOpacity="0" />
          </radialGradient>
        </defs>

        {config.backgroundPreset === 'recording-studio' && (
          <g opacity="0.9">
            <rect width="1080" height="1920" fill="#0b0c10" />
            <rect width="1080" height="1920" fill="url(#stageGlow)" />
            {/* Acoustic wall panels */}
            {[120, 310, 500, 690, 880].map((x) => (
              <rect
                key={x}
                x={x}
                y={280}
                width={90}
                height={340}
                rx={10}
                fill="#14141b"
                stroke="#27272a"
                strokeWidth={3}
              />
            ))}
            {/* Studio control desk */}
            <rect x={110} y={1340} width={860} height={46} rx={12} fill="#1f1f27" stroke="#3f3f46" strokeWidth={3} />
            <rect x={180} y={1386} width={36} height={360} fill="#18181f" />
            <rect x={864} y={1386} width={36} height={360} fill="#18181f" />
          </g>
        )}

        {config.backgroundPreset === 'vocal-booth' && (
          <g>
            <rect width="1080" height="1920" fill="#0c0a0f" />
            <rect width="1080" height="1920" fill="url(#stageGlow)" />
            <rect x={160} y={320} width={760} height={1160} rx={28} fill="#121218" stroke="#27272a" strokeWidth={4} />
            {/* Sound-foam ribs */}
            {Array.from({ length: 8 }).map((_, idx) => (
              <line
                key={idx}
                x1={220}
                y1={420 + idx * 120}
                x2={860}
                y2={420 + idx * 120}
                stroke="#27272a"
                strokeWidth={5}
              />
            ))}
          </g>
        )}

        {config.backgroundPreset === 'desk-setup' && (
          <g>
            <rect width="1080" height="1920" fill="#090b10" />
            <rect width="1080" height="1920" fill="url(#stageGlow)" />
            <rect x={120} y={1300} width={840} height={32} rx={8} fill="#27272a" />
            <rect x={360} y={1020} width={360} height={240} rx={16} fill="#111118" stroke={config.accentColor} strokeWidth={4} />
            <rect x={515} y={1260} width={50} height={40} fill="#3f3f46" />
          </g>
        )}

        {config.backgroundPreset === 'stage-spotlight' && (
          <g>
            <rect width="1080" height="1920" fill="#09090b" />
            <polygon points="540,40 120,1640 960,1640" fill={config.accentColor} opacity="0.11" />
            <ellipse cx={540} cy={1580} rx={380} ry={48} fill={config.accentColor} opacity="0.18" />
          </g>
        )}

        {config.backgroundPreset === 'mobile-analytics' && (
          <g>
            <rect width="1080" height="1920" fill="#090d14" />
            <rect x={220} y={420} width={640} height={1120} rx={54} fill="#111827" stroke="#334155" strokeWidth={6} />
            <rect x={440} y={452} width={200} height={16} rx={8} fill="#1e293b" />
          </g>
        )}

        {/* Props Layer */}
        {config.props.includes('studio-monitors') && (
          <g transform={`translate(0, ${floatY * 0.4})`}>
            {[160, 810].map((mx, i) => (
              <g key={i} transform={`translate(${mx}, 1060)`}>
                <rect x={0} y={0} width={110} height={180} rx={14} fill="#18181b" stroke="#52525b" strokeWidth={3} />
                <circle cx={55} cy={55} r={20} fill="#27272a" stroke={config.accentColor} strokeWidth={3} />
                <circle cx={55} cy={125} r={34} fill="#09090b" stroke="#71717a" strokeWidth={3} />
              </g>
            ))}
          </g>
        )}

        {config.props.includes('condenser-mic') && (
          <g transform={`translate(760, ${980 + floatY * 0.3})`}>
            <line x1={60} y1={110} x2={60} y2={380} stroke="#71717a" strokeWidth={10} strokeLinecap="round" />
            <rect x={28} y={24} width={64} height={96} rx={30} fill="#27272a" stroke={config.accentColor} strokeWidth={4} />
            <circle cx={60} cy={58} r={44} fill="none" stroke="#e4e4e7" strokeWidth={3} opacity="0.6" />
          </g>
        )}

        {config.props.includes('vinyl-record') && (
          <g transform={`translate(820, ${620 + floatY}) rotate(${t * 36})`}>
            <circle cx={0} cy={0} r={96} fill="#111113" stroke="#3f3f46" strokeWidth={4} />
            <circle cx={0} cy={0} r={66} fill="none" stroke="#27272a" strokeWidth={2} />
            <circle cx={0} cy={0} r={28} fill={config.accentColor} />
            <circle cx={0} cy={0} r={7} fill="#09090b" />
          </g>
        )}

        {config.props.includes('waveform') && (
          <g transform="translate(220, 1420)">
            {Array.from({ length: 24 }).map((_, idx) => {
              const h = barPulse(idx);
              return (
                <rect
                  key={idx}
                  x={idx * 27}
                  y={50 - h / 2}
                  width={15}
                  height={h}
                  rx={6}
                  fill={config.accentColor}
                  opacity={0.78}
                />
              );
            })}
          </g>
        )}

        {config.props.includes('cash-stack') && (
          <g transform={`translate(170, ${640 + floatY})`}>
            <rect x={0} y={0} width={150} height={82} rx={12} fill="#064e3b" stroke="#10b981" strokeWidth={3} />
            <text x={75} y={54} textAnchor="middle" fill="#6ee7b7" fontSize="42" fontWeight="700" fontFamily="Plus Jakarta Sans">
              $$$
            </text>
          </g>
        )}

        {/* 2D Stylized Character Silhouette/Bust (when enabled) */}
        {config.characterId !== 'none' && (
          <g transform={`translate(760, ${1140 + floatY * 0.5})`}>
            <circle cx={0} cy={-105} r={54} fill={config.characterColor} stroke="#18181b" strokeWidth={5} />
            <path
              d="M -78 90 C -78 -35, 78 -35, 78 90 Z"
              fill="#1f1f27"
              stroke={config.accentColor}
              strokeWidth={4}
            />
            {config.characterId === 'producer' || config.characterId === 'engineer' ? (
              <path
                d="M -60 -105 A 60 60 0 0 1 60 -105"
                fill="none"
                stroke={config.accentColor}
                strokeWidth={9}
                strokeLinecap="round"
              />
            ) : null}
            <circle cx={-18} cy={-110} r={5} fill="#09090b" />
            <circle cx={18} cy={-110} r={5} fill="#09090b" />
            <path d="M -12 -86 Q 0 -76 12 -86" fill="none" stroke="#09090b" strokeWidth={4} strokeLinecap="round" />
          </g>
        )}
      </svg>

      {/* Optional User-Uploaded Scene Image Overlay */}
      {config.customImageUrl && (
        <img
          src={config.customImageUrl}
          alt="Custom scene reference"
          style={{
            position: 'absolute',
            right: 72,
            top: 520,
            width: 340,
            height: 340,
            objectFit: 'cover',
            borderRadius: 24,
            border: `3px solid ${config.accentColor}`,
            boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
          }}
        />
      )}
    </div>
  );
};
