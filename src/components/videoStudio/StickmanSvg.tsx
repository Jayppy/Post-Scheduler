import React from 'react';
import type { StickmanAction, StickmanConfig } from '../../types/videoStudio';

interface StickmanSvgProps {
  config: StickmanConfig;
  frame: number;
  fps: number;
}

export const ALL_STICKMAN_ACTIONS: Array<{ id: StickmanAction; label: string }> = [
  { id: 'idle', label: 'Idle / Breathing' },
  { id: 'walking', label: 'Walking' },
  { id: 'pointing', label: 'Pointing' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'celebrating', label: 'Celebrating' },
  { id: 'explaining', label: 'Explaining' },
  { id: 'typing', label: 'Typing' },
  { id: 'presenting', label: 'Presenting' },
  { id: 'head-shake', label: 'Head Shake' },
  { id: 'nodding', label: 'Nodding' },
  { id: 'holding-mic', label: 'Holding Mic' },
  { id: 'working-at-desk', label: 'Working at Desk' },
  { id: 'looking-at-phone', label: 'Looking at Phone' },
  { id: 'showing-chart', label: 'Showing Chart' },
  { id: 'reacting-surprised', label: 'Reacting Surprised' },
  { id: 'crossed-arms', label: 'Crossed Arms' },
  { id: 'thumbs-up', label: 'Thumbs Up' },
  { id: 'waving', label: 'Waving' },
];

export const StickmanSvg: React.FC<StickmanSvgProps> = ({ config, frame, fps }) => {
  if (!config.enabled) return null;

  const t = frame / Math.max(1, fps);
  const pulse = Math.sin(t * 4.5);
  const slow = Math.sin(t * 2.4);
  const fast = Math.sin(t * 9.0);

  let bodyY = pulse * 4;
  let torsoTilt = 0;
  let headX = 0;
  let headY = 0;
  let lArmAngle = 25;
  let lForearmAngle = 15;
  let rArmAngle = -25;
  let rForearmAngle = -15;
  let lLegAngle = 10;
  let rLegAngle = -10;
  let propType: 'none' | 'mic' | 'phone' | 'laptop' | 'chart' | 'thumbs' = 'none';

  switch (config.action) {
    case 'idle':
      bodyY = pulse * 3;
      lArmAngle = 20 + slow * 4;
      rArmAngle = -20 - slow * 4;
      break;
    case 'walking':
      bodyY = Math.abs(Math.sin(t * 6)) * -10;
      torsoTilt = 6;
      lArmAngle = Math.sin(t * 6) * 42;
      rArmAngle = -Math.sin(t * 6) * 42;
      lLegAngle = -Math.sin(t * 6) * 34;
      rLegAngle = Math.sin(t * 6) * 34;
      break;
    case 'pointing':
      torsoTilt = -4;
      rArmAngle = -85 + pulse * 5;
      rForearmAngle = -10;
      lArmAngle = 25;
      break;
    case 'thinking':
      headY = -2;
      headX = 3;
      rArmAngle = -65;
      rForearmAngle = -115 + slow * 4;
      lArmAngle = 35;
      lForearmAngle = 40;
      break;
    case 'celebrating':
      bodyY = -Math.abs(Math.sin(t * 7)) * 18;
      lArmAngle = 135 + pulse * 14;
      rArmAngle = -135 - pulse * 14;
      lForearmAngle = 15;
      rForearmAngle = -15;
      lLegAngle = 18;
      rLegAngle = -18;
      break;
    case 'explaining':
      lArmAngle = 55 + pulse * 18;
      lForearmAngle = 35 - pulse * 14;
      rArmAngle = -55 - slow * 16;
      rForearmAngle = -35 + slow * 14;
      headY = pulse * 3;
      break;
    case 'typing':
      torsoTilt = 8;
      lArmAngle = 45 + fast * 6;
      lForearmAngle = 55 - fast * 8;
      rArmAngle = -45 - fast * 6;
      rForearmAngle = -55 + fast * 8;
      propType = 'laptop';
      break;
    case 'presenting':
      torsoTilt = -3;
      rArmAngle = -95 + slow * 10;
      rForearmAngle = -18;
      lArmAngle = 40;
      lForearmAngle = 25;
      break;
    case 'head-shake':
      headX = Math.sin(t * 10) * 11;
      lArmAngle = 30;
      rArmAngle = -30;
      break;
    case 'nodding':
      headY = Math.sin(t * 8) * 9;
      lArmAngle = 22;
      rArmAngle = -22;
      break;
    case 'holding-mic':
      rArmAngle = -52;
      rForearmAngle = -92 + pulse * 4;
      lArmAngle = 35 + slow * 10;
      propType = 'mic';
      break;
    case 'working-at-desk':
      torsoTilt = 10;
      lArmAngle = 40 + fast * 5;
      lForearmAngle = 60;
      rArmAngle = -40 - fast * 5;
      rForearmAngle = -60;
      propType = 'laptop';
      break;
    case 'looking-at-phone':
      headY = 8;
      torsoTilt = 6;
      rArmAngle = -48;
      rForearmAngle = -85 + slow * 3;
      lArmAngle = 24;
      propType = 'phone';
      break;
    case 'showing-chart':
      rArmAngle = -85;
      rForearmAngle = -25 + slow * 6;
      lArmAngle = 30;
      propType = 'chart';
      break;
    case 'reacting-surprised':
      bodyY = -8;
      torsoTilt = -6;
      lArmAngle = 110 + pulse * 8;
      rArmAngle = -110 - pulse * 8;
      lForearmAngle = 45;
      rForearmAngle = -45;
      break;
    case 'crossed-arms':
      lArmAngle = 38;
      lForearmAngle = 95;
      rArmAngle = -38;
      rForearmAngle = -95;
      break;
    case 'thumbs-up':
      rArmAngle = -72;
      rForearmAngle = -40 + pulse * 4;
      lArmAngle = 22;
      propType = 'thumbs';
      break;
    case 'waving':
      rArmAngle = -125;
      rForearmAngle = Math.sin(t * 11) * 28;
      lArmAngle = 24;
      break;
  }

  const headRadius = 38 * config.headScale;
  const strokeW = config.limbThickness;
  const flipScale = config.flipped ? -1 : 1;
  const hasHoodie = config.accessories.includes('hoodie');
  const hasCap = config.accessories.includes('cap');
  const hasHeadphones = config.accessories.includes('headphones');
  const hasGlasses = config.accessories.includes('glasses');
  const hasChain = config.accessories.includes('chain');

  const renderHead = () => {
    const cx = headX;
    const cy = -95 + headY;
    if (config.headShape === 'rounded-square') {
      return (
        <rect
          x={cx - headRadius}
          y={cy - headRadius}
          width={headRadius * 2}
          height={headRadius * 2}
          rx={18}
          fill={config.bodyColor}
          stroke={config.outlineColor}
          strokeWidth={Math.max(3, strokeW * 0.55)}
        />
      );
    }
    if (config.headShape === 'oval') {
      return (
        <ellipse
          cx={cx}
          cy={cy}
          rx={headRadius * 0.88}
          ry={headRadius * 1.12}
          fill={config.bodyColor}
          stroke={config.outlineColor}
          strokeWidth={Math.max(3, strokeW * 0.55)}
        />
      );
    }
    return (
      <circle
        cx={cx}
        cy={cy}
        r={headRadius}
        fill={config.bodyColor}
        stroke={config.outlineColor}
        strokeWidth={Math.max(3, strokeW * 0.55)}
      />
    );
  };

  const renderFace = () => {
    const cx = headX;
    const cy = -95 + headY;
    const eyeY = cy - 4;
    return (
      <g>
        {config.expression === 'surprised' ? (
          <>
            <circle cx={cx - 12} cy={eyeY} r={5} fill="#09090b" />
            <circle cx={cx + 12} cy={eyeY} r={5} fill="#09090b" />
            <ellipse cx={cx} cy={cy + 16} rx={6} ry={8} fill="#09090b" />
          </>
        ) : config.expression === 'happy' ? (
          <>
            <circle cx={cx - 12} cy={eyeY} r={4} fill="#09090b" />
            <circle cx={cx + 12} cy={eyeY} r={4} fill="#09090b" />
            <path
              d={`M ${cx - 12} ${cy + 11} Q ${cx} ${cy + 24} ${cx + 12} ${cy + 11}`}
              fill="none"
              stroke="#09090b"
              strokeWidth={3.5}
              strokeLinecap="round"
            />
          </>
        ) : config.expression === 'skeptical' ? (
          <>
            <line x1={cx - 17} y1={eyeY - 8} x2={cx - 7} y2={eyeY - 5} stroke="#09090b" strokeWidth={3} strokeLinecap="round" />
            <circle cx={cx - 12} cy={eyeY} r={3.5} fill="#09090b" />
            <circle cx={cx + 12} cy={eyeY} r={3.5} fill="#09090b" />
            <line x1={cx - 8} y1={cy + 15} x2={cx + 10} y2={cy + 12} stroke="#09090b" strokeWidth={3} strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx={cx - 11} cy={eyeY} r={3.8} fill="#09090b" />
            <circle cx={cx + 11} cy={eyeY} r={3.8} fill="#09090b" />
            <path
              d={`M ${cx - 8} ${cy + 13} Q ${cx} ${cy + 18} ${cx + 8} ${cy + 13}`}
              fill="none"
              stroke="#09090b"
              strokeWidth={3}
              strokeLinecap="round"
            />
          </>
        )}

        {hasGlasses && (
          <g stroke="#f59e0b" strokeWidth={3} fill="rgba(245,158,11,0.12)">
            <rect x={cx - 23} y={eyeY - 9} width={19} height={14} rx={4} />
            <rect x={cx + 4} y={eyeY - 9} width={19} height={14} rx={4} />
            <line x1={cx - 4} y1={eyeY - 2} x2={cx + 4} y2={eyeY - 2} />
          </g>
        )}

        {hasCap && (
          <g transform={`translate(${cx}, ${cy - headRadius + 4})`}>
            <path d="M -34 6 C -32 -22, 32 -22, 34 6 Z" fill="#18181b" stroke="#f59e0b" strokeWidth={3} />
            <path d="M -8 4 L 46 8 L 44 14 L -8 10 Z" fill="#f59e0b" />
          </g>
        )}

        {hasHeadphones && (
          <g>
            <path
              d={`M ${cx - headRadius - 4} ${cy} A ${headRadius + 6} ${headRadius + 6} 0 0 1 ${cx + headRadius + 4} ${cy}`}
              fill="none"
              stroke="#f59e0b"
              strokeWidth={6}
              strokeLinecap="round"
            />
            <rect x={cx - headRadius - 10} y={cy - 14} width={12} height={28} rx={6} fill="#27272a" stroke="#f59e0b" strokeWidth={2.5} />
            <rect x={cx + headRadius - 2} y={cy - 14} width={12} height={28} rx={6} fill="#27272a" stroke="#f59e0b" strokeWidth={2.5} />
          </g>
        )}
      </g>
    );
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: `${config.positionX}%`,
        top: `${config.positionY}%`,
        transform: `translate(-50%, -50%) scale(${config.scale * flipScale}, ${config.scale})`,
        pointerEvents: 'none',
      }}
    >
      <svg width={340} height={420} viewBox="-170 -200 340 420" overflow="visible">
        {/* Soft floor shadow */}
        <ellipse cx={0} cy={175} rx={58} ry={12} fill="rgba(0,0,0,0.45)" />

        <g transform={`translate(0, ${bodyY}) rotate(${torsoTilt})`}>
          {/* Legs */}
          <g transform="translate(-14, 52)">
            <g transform={`rotate(${lLegAngle})`}>
              <line x1={0} y1={0} x2={-12} y2={112} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
              <line x1={-12} y1={112} x2={-28} y2={114} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
            </g>
          </g>
          <g transform="translate(14, 52)">
            <g transform={`rotate(${rLegAngle})`}>
              <line x1={0} y1={0} x2={12} y2={112} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
              <line x1={12} y1={112} x2={28} y2={114} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
            </g>
          </g>

          {/* Torso */}
          {hasHoodie ? (
            <path
              d="M -28 -48 L 28 -48 L 36 56 L -36 56 Z"
              fill="#27272a"
              stroke={config.bodyColor}
              strokeWidth={4}
              strokeLinejoin="round"
            />
          ) : (
            <line
              x1={0}
              y1={-52}
              x2={0}
              y2={56}
              stroke={config.bodyColor}
              strokeWidth={strokeW + 2}
              strokeLinecap="round"
            />
          )}

          {hasChain && (
            <path
              d="M -14 -44 Q 0 -18 14 -44"
              fill="none"
              stroke="#fbbf24"
              strokeWidth={3.5}
              strokeLinecap="round"
            />
          )}

          {/* Left Arm */}
          <g transform="translate(-8, -40)">
            <g transform={`rotate(${lArmAngle})`}>
              <line x1={0} y1={0} x2={-38} y2={38} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
              <g transform={`translate(-38, 38) rotate(${lForearmAngle})`}>
                <line x1={0} y1={0} x2={-28} y2={34} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
              </g>
            </g>
          </g>

          {/* Right Arm */}
          <g transform="translate(8, -40)">
            <g transform={`rotate(${rArmAngle})`}>
              <line x1={0} y1={0} x2={38} y2={38} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
              <g transform={`translate(38, 38) rotate(${rForearmAngle})`}>
                <line x1={0} y1={0} x2={28} y2={34} stroke={config.bodyColor} strokeWidth={strokeW} strokeLinecap="round" />
                {propType === 'mic' && (
                  <g transform="translate(28, 34)">
                    <line x1={0} y1={0} x2={8} y2={-22} stroke="#a1a1aa" strokeWidth={5} strokeLinecap="round" />
                    <circle cx={10} cy={-26} r={9} fill="#f59e0b" stroke="#18181b" strokeWidth={2} />
                  </g>
                )}
                {propType === 'phone' && (
                  <rect x={18} y={18} width={18} height={30} rx={3} fill="#18181b" stroke="#38bdf8" strokeWidth={2.5} />
                )}
                {propType === 'thumbs' && (
                  <circle cx={32} cy={28} r={9} fill="#10b981" />
                )}
              </g>
            </g>
          </g>

          {/* Props in front of character */}
          {propType === 'laptop' && (
            <g transform="translate(46, 30)">
              <rect x={-32} y={-28} width={64} height={40} rx={5} fill="#18181b" stroke="#a1a1aa" strokeWidth={3} />
              <rect x={-42} y={14} width={84} height={8} rx={3} fill="#52525b" />
            </g>
          )}
          {propType === 'chart' && (
            <g transform="translate(88, -10)">
              <rect x={-44} y={-44} width={88} height={70} rx={8} fill="#111116" stroke="#f59e0b" strokeWidth={2.5} />
              <rect x={-30} y={2} width={12} height={16} fill="#38bdf8" />
              <rect x={-8} y={-12} width={12} height={30} fill="#f59e0b" />
              <rect x={14} y={-28} width={12} height={46} fill="#10b981" />
            </g>
          )}

          {/* Head + Face */}
          {renderHead()}
          {renderFace()}
        </g>
      </svg>
    </div>
  );
};
