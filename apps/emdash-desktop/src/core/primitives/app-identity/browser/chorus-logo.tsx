import { useId } from 'react';

/** Bar heights (0–1) of the mark: five voices of a chord, loudest in the middle. */
const BARS = [0.42, 0.72, 1, 0.62, 0.34] as const;

/**
 * The Chorus mark: five rounded bars, a chord of agents and a voice meter at once. Bars breathe
 * gently unless the user prefers reduced motion.
 */
export function ChorusMark({
  size = 32,
  className,
  animated = true,
}: {
  size?: number;
  className?: string;
  animated?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = animated && !prefersReduced;
  const barWidth = 3.4;
  const gap = 2.3;
  const total = BARS.length * barWidth + (BARS.length - 1) * gap;
  const offset = (32 - total) / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Chorus"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={`chorus-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="55%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="#0f1115" />
      {BARS.map((height, index) => {
        const h = 5 + height * 15;
        const x = offset + index * (barWidth + gap);
        const y = (32 - h) / 2;
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={barWidth / 2}
            fill={`url(#chorus-${uid})`}
          >
            {animate && (
              <>
                <animate
                  attributeName="height"
                  values={`${h};${h * 0.7};${h}`}
                  dur={`${1.6 + index * 0.23}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="y"
                  values={`${y};${(32 - h * 0.7) / 2};${y}`}
                  dur={`${1.6 + index * 0.23}s`}
                  repeatCount="indefinite"
                />
              </>
            )}
          </rect>
        );
      })}
    </svg>
  );
}

/** Mark plus wordmark, for the home screen. */
export function ChorusWordmark({
  height = 32,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: height * 0.35 }}
    >
      <ChorusMark size={height} />
      <span
        style={{ fontSize: height * 0.82, lineHeight: 1 }}
        className="font-semibold tracking-tight text-foreground"
      >
        chorus
      </span>
    </span>
  );
}
