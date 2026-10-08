import type { ITheme } from '@xterm/xterm';

/** Preferred terminal face first, then what phones and desktops ship. */
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono Variable", ui-monospace, Menlo, Monaco, Consolas, "Roboto Mono", monospace';

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * xterm parses only hex and rgb() colors, while the theme tokens are `color(display-p3 …)` and
 * `color-mix()` expressions. Painting the color and reading the pixel back converts anything the
 * browser understands.
 */
export function cssColorToHex(color: string, fallback: string): string {
  if (probe === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!probe || !color) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  if (a === 0) return fallback;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The terminal palette for the active theme, read from the same tokens the desktop app uses. */
export function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains('emdark');
  const token = (name: string, fallback: string): string =>
    cssColorToHex(styles.getPropertyValue(name).trim(), fallback);
  const foreground = token('--em-foreground', dark ? '#e9e9e9' : '#222222');
  const background = token('--em-surface-paper', dark ? '#191919' : '#fcfcfc');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? '#2b5a94' : '#a6c8ff',
    selectionForeground: dark ? '#e6f1ff' : '#0b1f3d',
  };
}
