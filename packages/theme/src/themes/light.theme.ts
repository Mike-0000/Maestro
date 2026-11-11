/**
 * Light theme — the light sibling of the deep-slate dark theme.
 *
 * Same product, other polarity: the same cool slate hue (OKLCH H 230) at a
 * lower chroma, the same jade accent family (H 176), the same type, radii and
 * surface ladder semantics. Structure comes from small surface steps, not
 * lines, and text does the work.
 *   - Neutral: explicit slate ramp, background L 0.99. Passive text (step 9)
 *     keeps ≥ 4.5:1 on the sunken chrome (sidebar, title bar), so no app-side
 *     contrast override is needed; checkbox / radio edges (step 8) keep ≥ 3:1.
 *   - Accent: explicit jade ramp. The primary button is a deep jade solid
 *     (L 0.50) with white ink (5.7:1), the polarity mirror of the dark theme's
 *     sea-glass solid with dark ink. Its rim (step 7) sits just below the solid
 *     like the dark one; the focus ring (8) keeps ≥ 3:1 on white; links (11)
 *     ≥ 4.5:1 on every surface.
 *   - Hue scales: generated at the generator's natural chroma.
 *
 * The app's `.emlight` palette (apps/emdash-desktop/src/renderer/index.css)
 * aliases these generated --em-* values, so this file is the single place to
 * tune the light neutral ramp and accent.
 */

import Color from 'colorjs.io';
import { defineTheme } from '../core/index';

/** OKLCH hue of the neutral ramp and, through step 1, of every surface. */
const NEUTRAL_HUE = 230;
/** OKLCH hue of the accent (the dark theme's jade). */
const ACCENT_HUE = 176;

/** One OKLCH colour emitted in the display-p3 notation the generator uses. */
function p3(lightness: number, chroma: number, hue: number): string {
  const channels = new Color('oklch', [lightness, chroma, hue])
    .to('p3')
    .coords.map((v) => Math.max(0, Math.min(1, +Number(v).toFixed(4))));
  return `color(display-p3 ${channels.join(' ')})`;
}

const slate = (l: number, c: number) => p3(l, c, NEUTRAL_HUE);
const jade = (l: number, c: number) => p3(l, c, ACCENT_HUE);

export const lightTheme = defineTheme({
  id: 'light',
  label: 'Light',
  polarity: 'light',

  accent: { hue: ACCENT_HUE, chroma: 0.1 },

  hues: {
    green: 147,
    red: 23,
    amber: 81,
    blue: 252,
    orange: 55,
    purple: 305,
  },

  scales: {
    neutral: [
      slate(0.99, 0.003), //   1  app background
      slate(0.975, 0.004), //  2  subtle background
      slate(0.958, 0.005), //  3  component background, active row
      slate(0.94, 0.006), //   4  hover
      slate(0.922, 0.007), //  5  pressed, subtle border
      slate(0.9, 0.008), //    6  hairline border
      slate(0.79, 0.01), //    7  control border (inputs at rest)
      slate(0.62, 0.012), //   8  strong border: checkbox / radio edge (≥ 3:1)
      slate(0.53, 0.014), //   9  passive text, glyphs (≥ 4.5:1 on sunken)
      slate(0.48, 0.014), //  10  hovered passive text
      slate(0.41, 0.014), //  11  muted text, labels
      slate(0.205, 0.012), // 12  text
    ],
    accent: [
      jade(0.985, 0.006), //  1
      jade(0.965, 0.012), //  2
      jade(0.935, 0.024), //  3
      jade(0.905, 0.036), //  4
      jade(0.87, 0.05), //    5
      jade(0.82, 0.065), //   6
      jade(0.455, 0.09), //   7  primary button rim (just below the solid)
      jade(0.6, 0.1), //      8  focus ring (≥ 3:1 on white)
      jade(0.5, 0.095), //    9  primary button solid, white ink 5.7:1
      jade(0.455, 0.09), //  10  primary button hover
      jade(0.47, 0.085), //  11  links (≥ 4.5:1 on every surface)
      jade(0.25, 0.04), //   12
    ],
  },

  contrast: 'normal',
  background: { lightness: 0.99 },

  // Light surface ladder: chrome (sidebar, title bar, tab strip) on a soft
  // sunken grey, content on near-white paper, cards a step below paper.
  surfaceLightness: {
    sunken: 0.955,
    base: 0.975,
    'base-emphasis': 0.985,
    elevated: 0.995,
    'elevated-emphasis': 0.978,
    paper: 0.995,
  },

  gamut: 'p3',

  // Amber sits at a gamut cusp: vivid yellow/amber lives at high L. This is a
  // property of the hue, so the tweak is keyed to the `amber` scale itself.
  tweaks: {
    amber: {
      darkForeground: true,
      steps: {
        9: { l: +0.03 },
        10: { l: +0.02 },
        11: { l: -0.02 },
      },
    },
  },

  syntax: { generate: true },
});
