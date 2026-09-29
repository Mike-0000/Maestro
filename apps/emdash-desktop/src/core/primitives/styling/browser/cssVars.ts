export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const HEX_CACHE_LIMIT = 256;
const hexCache = new Map<string, string>();
let probe: CanvasRenderingContext2D | null | undefined;

function probeContext(): CanvasRenderingContext2D | null {
  if (probe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
  }
  return probe;
}

/**
 * Converts any CSS color string (hex, hsl, color(display-p3 ...), color-mix, etc.)
 * to a hex string by painting a 1×1 canvas pixel and reading back the sRGB bytes.
 * Out-of-gamut P3 values are clamped to sRGB, which is imperceptible for UI chrome colors.
 * Returns the original string unchanged if the canvas context is unavailable.
 *
 * The conversion is pure for a given input, so results are memoized: terminals resolve the same
 * handful of theme colors on every theme application, and each uncached conversion is a
 * synchronous canvas readback.
 */
export function cssColorToHex(cssColor: string): string {
  const input = cssColor.trim();
  const cached = hexCache.get(input);
  if (cached !== undefined) return cached;
  const ctx = probeContext();
  if (!ctx) return cssColor;
  ctx.clearRect(0, 0, 1, 1);
  // An unparsable color leaves fillStyle unchanged, so reset it first to keep the
  // result independent of the previous conversion.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = input;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const result = a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
  if (hexCache.size >= HEX_CACHE_LIMIT) hexCache.clear();
  hexCache.set(input, result);
  return result;
}
