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

/** `amount` (0–1) of `top` laid over `bottom`, both `#rrggbb`. */
function mixHex(top: string, bottom: string, amount: number): string {
  const channel = (hex: string, index: number): number =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(top, index) * amount + channel(bottom, index) * (1 - amount))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * xterm theme keys for the 16 ANSI colours and the tokens that define them, the same tokens and
 * values as the desktop terminal (src/assets/styles/terminal-ansi.css, imported by styles.css).
 */
export const ANSI_COLOR_VARS = {
  black: '--xterm-ansi-black',
  red: '--xterm-ansi-red',
  green: '--xterm-ansi-green',
  yellow: '--xterm-ansi-yellow',
  blue: '--xterm-ansi-blue',
  magenta: '--xterm-ansi-magenta',
  cyan: '--xterm-ansi-cyan',
  white: '--xterm-ansi-white',
  brightBlack: '--xterm-ansi-bright-black',
  brightRed: '--xterm-ansi-bright-red',
  brightGreen: '--xterm-ansi-bright-green',
  brightYellow: '--xterm-ansi-bright-yellow',
  brightBlue: '--xterm-ansi-bright-blue',
  brightMagenta: '--xterm-ansi-bright-magenta',
  brightCyan: '--xterm-ansi-bright-cyan',
  brightWhite: '--xterm-ansi-bright-white',
} as const satisfies Partial<Record<keyof ITheme, string>>;

/**
 * The terminal palette for the active theme, read from the same tokens the desktop app uses.
 * Selection is an accent tint with ordinary text over it, as in the desktop terminal (30% in
 * dark, 22% in light). The fallbacks are sRGB stand-ins for the tokens, used only when a token
 * cannot be read.
 */
export function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains('emdark');
  const token = (name: string, fallback: string): string =>
    cssColorToHex(styles.getPropertyValue(name).trim(), fallback);
  const foreground = token('--em-foreground', dark ? '#eceff1' : '#12181c');
  const background = token('--em-surface-paper', dark ? '#13191c' : '#fcfeff');
  const accent = token('--em-accent', dark ? '#55b9a2' : '#007461');
  const theme: ITheme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: mixHex(accent, background, dark ? 0.3 : 0.22),
    selectionForeground: foreground,
  };
  // A token that cannot be read keeps xterm's default for that colour.
  for (const [key, name] of Object.entries(ANSI_COLOR_VARS)) {
    const hex = token(name, '');
    if (hex) theme[key as keyof typeof ANSI_COLOR_VARS] = hex;
  }
  return theme;
}
