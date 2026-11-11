/**
 * Dark theme — the default dark palette ("deep slate").
 *
 * One deep, low-chroma ground with almost no lines: structure comes from small
 * surface steps rather than borders, and text does the work.
 *   - Neutral: cool slate (OKLCH H 230, C ≈ 0.015), background at L 0.21.
 *     The hue sits close to the accent so the ground and the accent read as one
 *     family and the accent stays quiet.
 *   - Accent: one restrained jade-teal (H 176, C 0.10), reserved for the focus
 *     ring, the primary button, links and the "working" pulse.
 *   - Hue scales: green, red, amber, blue, orange, purple at the generator's
 *     natural chroma, anchored on the same background.
 *
 * The app's hand-written palette (apps/emdash-desktop/src/renderer/index.css,
 * `.emdark`) aliases these generated --em-* values, so this file is the single
 * place to tune the dark neutral ramp and accent.
 */

import Color from 'colorjs.io';
import { defineTheme } from '../core/index';

/** OKLCH hue of the neutral ramp and, through step 1, of every surface. */
const NEUTRAL_HUE = 230;

/**
 * One neutral step, authored in OKLCH and emitted in the display-p3 notation
 * every other generated token uses (4 decimals, like the generator's output).
 */
function slate(lightness: number, chroma: number): string {
  const channels = new Color('oklch', [lightness, chroma, NEUTRAL_HUE])
    .to('p3')
    .coords.map((v) => Math.max(0, Math.min(1, +Number(v).toFixed(4))));
  return `color(display-p3 ${channels.join(' ')})`;
}

export const darkTheme = defineTheme({
  id: 'dark',
  label: 'Dark',
  polarity: 'dark',

  accent: { hue: 176, chroma: 0.1 },

  hues: {
    green: 147,
    red: 23,
    amber: 81,
    blue: 252,
    orange: 55,
    purple: 305,
  },

  // Explicit neutral ramp (the same escape hatch solarized-dark uses). The
  // generated neutral curve gives surfaces almost no tint and spaces the
  // background steps unevenly; this ramp keeps steps 1–6 exactly 0.02 L apart
  // so fills, hovers and hairlines line up with the surface ladder below.
  scales: {
    neutral: [
      slate(0.21, 0.014), //  1  app background, reading surface
      slate(0.23, 0.015), //  2  subtle background
      slate(0.25, 0.015), //  3  component background, user bubble, active row
      slate(0.27, 0.016), //  4  hover
      slate(0.29, 0.016), //  5  pressed, subtle border, scrollbar thumb
      slate(0.31, 0.016), //  6  hairline border (quiet)
      slate(0.45, 0.016), //  7  control border (checkbox, input hover)
      slate(0.515, 0.016), // 8  strong border, outline button
      slate(0.6, 0.015), //   9  passive text, glyphs (4.5:1 on step 1)
      slate(0.66, 0.014), // 10  hovered passive text
      slate(0.75, 0.011), // 11  muted text, labels
      slate(0.95, 0.004), // 12  text
    ],
  },

  contrast: 'normal',
  // APCA anchor and step-1 lightness for the generated accent and hue scales.
  background: { lightness: 0.21 },

  // Dark surface ladder (sunken → elevated-emphasis), overriding the shared
  // SURFACE_L defaults for this theme only. Chrome (sidebar, title bar, tab
  // strip) sits on sunken; content and paper share the background.
  surfaceLightness: {
    sunken: 0.18,
    base: 0.21,
    'base-emphasis': 0.23,
    elevated: 0.255,
    'elevated-emphasis': 0.29,
    paper: 0.21,
  },

  gamut: 'p3',

  tweaks: {
    amber: {
      darkForeground: true,
      steps: {
        9: { l: +0.05 },
        10: { l: +0.04 },
        11: { l: -0.01 },
      },
    },
    accent: {
      // Lift the solid to L ≈ 0.72 so the primary button reads as soft sea-glass
      // with dark ink, and keep its border (7) and the focus ring (8) close to it.
      steps: {
        7: { l: +0.06 },
        8: { l: +0.05 },
        9: { l: +0.07 },
        10: { l: +0.065 },
      },
    },
  },

  syntax: { generate: true },
});
