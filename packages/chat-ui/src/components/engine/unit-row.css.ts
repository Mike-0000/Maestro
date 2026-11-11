import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** Debug overlay: dashed outline around the reserved height slot. */
export const debugOverlay = style({
  pointerEvents: 'none',
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  outlineStyle: 'dashed',
  outlineWidth: '1px',
});

/** Debug overlay in OK state — faint accent outline (development-only overlay). */
export const debugOk = style({
  outlineColor: `color-mix(in srgb, ${vars.accent} 50%, transparent)`,
});

/** Debug overlay in mismatch state — error outline. */
export const debugMismatch = style({
  outlineColor: vars.fgError,
});

/** Debug label chip — inverted chip, small text. */
export const debugLabel = style({
  position: 'absolute',
  top: 0,
  left: 0,
  background: vars.fg,
  paddingLeft: '4px',
  paddingRight: '4px',
  fontSize: '9px',
  lineHeight: 'tight',
  color: vars.bg,
});

/** Debug mismatch text — red. */
export const debugMismatchText = style({
  color: vars.diffDeleted,
});
