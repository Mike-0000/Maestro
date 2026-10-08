import { useId } from 'react';

/** The Maestro mark: five bars of a waveform, as on the desktop app's icon. */
export function BrandMark({ size = 56 }: { size?: number }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Maestro"
      className="shrink-0"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="96"
          y1="192"
          x2="928"
          y2="832"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#6a6cff" />
          <stop offset="0.55" stopColor="#3d84f7" />
          <stop offset="1" stopColor="#22a3c9" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" fill="#101216" />
      <g fill={`url(#${gradientId})`}>
        <rect x="92" y="330" width="110" height="362" rx="55" />
        <rect x="275" y="258" width="110" height="507" rx="55" />
        <rect x="457" y="190" width="110" height="642" rx="55" />
        <rect x="640" y="282" width="110" height="459" rx="55" />
        <rect x="822" y="350" width="110" height="324" rx="55" />
      </g>
    </svg>
  );
}
