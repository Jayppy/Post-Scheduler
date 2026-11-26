import React from 'react';
import { interpolate, spring } from 'remotion';
import type { MotionGraphicsConfig } from '../../types/videoStudio';

interface MotionGraphicsLayerProps {
  config: MotionGraphicsConfig;
  frame: number;
  fps: number;
}

export const MotionGraphicsLayer: React.FC<MotionGraphicsLayerProps> = ({
  config,
  frame,
  fps,
}) => {
  const enterProgress = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 120, mass: 0.7 },
  });

  const slideY = interpolate(enterProgress, [0, 1], [36, 0]);
  const opacity = interpolate(frame, [0, Math.min(12, fps * 0.4)], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const highlightSet = new Set(
    (config.highlightWords || []).map((w) => w.toLowerCase().trim()).filter(Boolean)
  );

  const renderKineticHeadline = (text: string) => {
    const words = text.split(/\s+/);
    return words.map((word, idx) => {
      const clean = word.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
      const isHighlighted =
        highlightSet.has(clean) ||
        Array.from(highlightSet).some((hw) => hw.split(/\s+/).includes(clean));
      return (
        <span
          key={`${word}-${idx}`}
          style={{
            color: isHighlighted ? config.accentColor : '#f4f4f5',
            marginRight: '0.26em',
            display: 'inline-block',
          }}
        >
          {word}
        </span>
      );
    });
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '130px 72px 260px 72px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        pointerEvents: 'none',
        opacity,
        transform: `translateY(${slideY}px)`,
      }}
    >
      {/* Top Editorial Block */}
      <div style={{ maxWidth: 920 }}>
        {config.kicker && (
          <div
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 26,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: config.accentColor,
              marginBottom: 18,
              fontWeight: 600,
            }}
          >
            {config.kicker}
          </div>
        )}

        <h1
          style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif',
            fontSize: 74,
            lineHeight: 1.06,
            fontWeight: 800,
            margin: 0,
            letterSpacing: '-0.025em',
            textShadow: '0 8px 32px rgba(0,0,0,0.65)',
          }}
        >
          {renderKineticHeadline(config.headline)}
        </h1>

        {config.subheadline && (
          <p
            style={{
              fontFamily: 'Manrope, sans-serif',
              fontSize: 34,
              lineHeight: 1.36,
              color: '#d4d4d8',
              marginTop: 22,
              maxWidth: 820,
              fontWeight: 500,
            }}
          >
            {config.subheadline}
          </p>
        )}

        {config.kpiValue && (
          <div
            style={{
              marginTop: 34,
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 20,
              padding: '20px 30px',
              borderRadius: 18,
              backgroundColor: 'rgba(17, 17, 23, 0.86)',
              border: `2px solid ${config.accentColor}`,
            }}
          >
            <span
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 64,
                fontWeight: 700,
                color: config.accentColor,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {config.kpiValue}
            </span>
            {config.kpiLabel && (
              <span
                style={{
                  fontFamily: 'Manrope, sans-serif',
                  fontSize: 28,
                  color: '#e4e4e7',
                  fontWeight: 600,
                }}
              >
                {config.kpiLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Middle Data Visualization / Comparison / Timeline Card */}
      {config.chartType !== 'none' && (
        <div
          style={{
            width: '100%',
            maxWidth: 920,
            padding: 36,
            borderRadius: 24,
            backgroundColor: 'rgba(13, 13, 18, 0.88)',
            border: '2px solid rgba(255,255,255,0.12)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
          }}
        >
          {(config.chartType === 'bar' || config.chartType === 'line') &&
            config.chartData &&
            config.chartData.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, height: 240 }}>
                {config.chartData.map((item, idx) => {
                  const barGrow = spring({
                    frame: Math.max(0, frame - idx * 4),
                    fps,
                    config: { damping: 14, stiffness: 110 },
                  });
                  const barHeight = Math.max(20, (item.value / 100) * 180 * barGrow);
                  return (
                    <div
                      key={item.label}
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        height: '100%',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 24,
                          color: '#fafafa',
                          marginBottom: 10,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {Math.round(item.value * barGrow)}%
                      </span>
                      <div
                        style={{
                          width: '100%',
                          height: barHeight,
                          borderRadius: 12,
                          backgroundColor:
                            idx === config.chartData!.length - 1 ? config.accentColor : '#3f3f46',
                        }}
                      />
                      <span
                        style={{
                          marginTop: 12,
                          fontFamily: 'Manrope, sans-serif',
                          fontSize: 24,
                          color: '#a1a1aa',
                          fontWeight: 600,
                        }}
                      >
                        {item.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

          {config.chartType === 'comparison' &&
            config.comparisonLeft &&
            config.comparisonRight && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
                <div
                  style={{
                    padding: 24,
                    borderRadius: 16,
                    backgroundColor: 'rgba(239, 68, 68, 0.08)',
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                  }}
                >
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#fca5a5', marginBottom: 14 }}>
                    {config.comparisonLeft.label}
                  </div>
                  {config.comparisonLeft.points.map((pt) => (
                    <div key={pt} style={{ fontSize: 24, color: '#d4d4d8', marginBottom: 8 }}>
                      - {pt}
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    padding: 24,
                    borderRadius: 16,
                    backgroundColor: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                  }}
                >
                  <div style={{ fontSize: 26, fontWeight: 700, color: '#6ee7b7', marginBottom: 14 }}>
                    {config.comparisonRight.label}
                  </div>
                  {config.comparisonRight.points.map((pt) => (
                    <div key={pt} style={{ fontSize: 24, color: '#fafafa', marginBottom: 8 }}>
                      + {pt}
                    </div>
                  ))}
                </div>
              </div>
            )}

          {(config.chartType === 'timeline' || config.chartType === 'flowchart') &&
            config.timelineSteps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {config.timelineSteps.map((st, idx) => (
                  <div
                    key={st.step}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 22,
                      padding: '14px 20px',
                      borderRadius: 14,
                      backgroundColor: '#18181f',
                      border: `1px solid ${idx === config.timelineSteps!.length - 1 ? config.accentColor : '#27272a'}`,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 26,
                        fontWeight: 700,
                        color: config.accentColor,
                        minWidth: 110,
                      }}
                    >
                      {st.step}
                    </span>
                    <span style={{ fontSize: 28, color: '#f4f4f5', fontWeight: 600 }}>
                      {st.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
};
