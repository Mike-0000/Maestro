import '@emdash/theme/theme.css';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readXtermCssVars,
  XTERM_ANSI_COLOR_VARS,
} from '@core/features/terminals/api/browser/pty/pty';
import { ANSI_COLOR_VARS as PHONE_ANSI_COLOR_VARS } from '../../../remote-web/lib/terminal-theme';
// The 16 ANSI colours, shared with the phone web app; index.css imports it, which a raw style
// element cannot follow, so it is added the same way.
import ansiCss from '@/assets/styles/terminal-ansi.css?raw';
import phoneCss from '@/remote-web/styles.css?raw';
// The app stylesheet as text: Tailwind directives are ignored by the browser, while the
// `.emdark` / `.emlight` palettes and the `--xterm-*` tokens apply exactly as in the app.
import appCss from '@renderer/index.css?raw';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('terminal ANSI palette', () => {
  let style: HTMLStyleElement;

  beforeAll(() => {
    style = document.createElement('style');
    style.textContent = `${appCss}\n${ansiCss}`;
    document.head.appendChild(style);
  });

  afterAll(() => {
    style.remove();
    document.documentElement.className = '';
  });

  for (const themeClass of ['emdark', 'emlight']) {
    it(`gives all 16 colours at least 4.5:1 on the terminal ground in ${themeClass}`, () => {
      document.documentElement.className = themeClass;
      const theme = readXtermCssVars() as Record<string, string>;
      const background = theme.background;
      expect(background).toMatch(/^#[0-9a-f]{6}$/);

      const ratios = Object.fromEntries(
        Object.keys(XTERM_ANSI_COLOR_VARS).map((key) => {
          expect(theme[key], `${key} is defined`).toMatch(/^#[0-9a-f]{6}$/);
          return [key, Math.round(contrast(theme[key], background) * 100) / 100];
        })
      );
      expect(Object.keys(ratios)).toHaveLength(16);
      for (const [key, ratio] of Object.entries(ratios)) {
        expect(ratio, `${key} ${theme[key]} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('keeps the hues apart so red, green, yellow, blue, magenta and cyan stay recognisable', () => {
    for (const themeClass of ['emdark', 'emlight']) {
      document.documentElement.className = themeClass;
      const theme = readXtermCssVars() as Record<string, string>;
      const hue = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (d === 0) return Number.NaN;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
      };
      // Hue windows (degrees) wide enough for any sensible ramp, narrow enough to catch a swap.
      const windows: Record<string, [number, number]> = {
        red: [340, 25],
        green: [80, 160],
        yellow: [35, 70],
        blue: [195, 250],
        magenta: [260, 320],
        cyan: [170, 210],
      };
      for (const [name, [from, to]] of Object.entries(windows)) {
        for (const key of [name, `bright${name[0].toUpperCase()}${name.slice(1)}`]) {
          const h = hue(theme[key]);
          const inside = from < to ? h >= from && h <= to : h >= from || h <= to;
          expect(inside, `${themeClass} ${key} ${theme[key]} hue ${Math.round(h)}`).toBe(true);
        }
      }
    }
  });

  it('gives the phone web app the same palette from the same source', () => {
    // Same token names, so the phone's xterm reads the colours the desktop's does...
    expect(PHONE_ANSI_COLOR_VARS).toEqual(XTERM_ANSI_COLOR_VARS);
    // ...from the one shared stylesheet, with no copy of its own that could drift.
    expect(phoneCss).toContain("@import '../assets/styles/terminal-ansi.css';");
    expect(phoneCss).not.toMatch(/--xterm-ansi-[a-z-]+\s*:/);
    expect(appCss).not.toMatch(/--xterm-ansi-[a-z-]+\s*:/);
  });
});
