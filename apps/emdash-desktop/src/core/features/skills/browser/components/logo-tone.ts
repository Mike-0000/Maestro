import { useEffect, useState } from 'react';

/**
 * How a catalog logo should be drawn. `glyph`: artwork on a transparent ground, flattened to the
 * text colour so it follows the theme. `tile`: an opaque picture (a square app icon, an avatar),
 * drawn as published, because flattening it leaves a solid black or white square.
 * `unknown`: not measured yet, or the image could not be read (drawn as published).
 */
export type LogoTone = 'glyph' | 'tile' | 'unknown';

const SAMPLE_SIZE = 24;
/** A logo counts as artwork on a transparent ground when this share of it is see-through. */
const TRANSPARENT_SHARE = 0.08;

const cache = new Map<string, Promise<LogoTone>>();

/** Measures a loaded image's see-through share on a small canvas. */
export function measureLogoTone(image: CanvasImageSource): LogoTone {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 'unknown';
  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    let transparent = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 128) transparent += 1;
    }
    return transparent / (SAMPLE_SIZE * SAMPLE_SIZE) >= TRANSPARENT_SHARE ? 'glyph' : 'tile';
  } catch {
    // A cross-origin image without CORS taints the canvas; it cannot be measured.
    return 'unknown';
  }
}

function loadLogoTone(url: string): Promise<LogoTone> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise<LogoTone>((resolve) => {
      // A separate probe, so the visible image never depends on the server allowing CORS.
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.decoding = 'async';
      probe.onload = () => resolve(measureLogoTone(probe));
      probe.onerror = () => resolve('unknown');
      probe.src = url;
    });
    cache.set(url, pending);
  }
  return pending;
}

/** The tone of the logo at `url`; `null` while it is being measured. */
export function useLogoTone(url: string | undefined): LogoTone | null {
  const [measured, setMeasured] = useState<{ url: string; tone: LogoTone } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    void loadLogoTone(url).then((tone) => {
      if (!cancelled) setMeasured({ url, tone });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!url) return 'unknown';
  return measured?.url === url ? measured.tone : null;
}
