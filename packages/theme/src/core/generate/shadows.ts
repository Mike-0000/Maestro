import { nsName } from '../contract/namespace';
import type { Polarity, Ramp } from '../contract/roles';

function mix(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${alpha}%, transparent)`;
}

/**
 * A shadow that draws nothing but still composes inside a comma-separated
 * `box-shadow` list (`none` would invalidate the whole declaration when a
 * recipe appends a hairline ring to it).
 */
const NO_SHADOW = '0 0 0 0 transparent';

/**
 * Elevation shadows and the modal backdrop, per polarity.
 *
 * Light: soft ink-tinted shadows on floating layers only (menus, popovers,
 * dialogs), since a near-white popup on a near-white page needs a shadow to
 * separate.
 *
 * Dark: shadows are invisible on a deep ground (a shadow tinted with the
 * background colour casts nothing on it), so sm / md / lg draw nothing and
 * elevation reads from the surface step plus a hairline that the popup
 * recipes add. Only `overlay` (dialogs and sheets) keeps a soft black shadow,
 * which lifts a dialog off the dimmed backdrop.
 *
 * `--em-backdrop` is the modal scrim: black at 55% in dark, slate ink at 30%
 * in light, no blur.
 */
export function generateShadowVars(neutralRamp: Ramp, polarity: Polarity): Record<string, string> {
  if (polarity === 'dark') {
    return {
      [nsName('shadow-sm')]: NO_SHADOW,
      [nsName('shadow-md')]: NO_SHADOW,
      [nsName('shadow-lg')]: NO_SHADOW,
      [nsName('shadow-overlay')]: `0 24px 64px ${mix('black', 45)}, 0 8px 24px ${mix('black', 25)}`,
      [nsName('backdrop')]: mix('black', 55),
    };
  }

  const ink = neutralRamp.steps[11];
  return {
    [nsName('shadow-sm')]: `0 1px 2px ${mix(ink, 8)}, 0 1px 1px ${mix(ink, 5)}`,
    [nsName('shadow-md')]: `0 8px 24px ${mix(ink, 10)}, 0 2px 8px ${mix(ink, 6)}`,
    [nsName('shadow-lg')]: `0 16px 48px ${mix(ink, 12)}, 0 4px 16px ${mix(ink, 8)}`,
    [nsName('shadow-overlay')]: `0 24px 80px ${mix(ink, 16)}, 0 8px 32px ${mix(ink, 10)}`,
    [nsName('backdrop')]: mix(ink, 30),
  };
}
