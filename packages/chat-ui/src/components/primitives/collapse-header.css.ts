import { style } from '@vanilla-extract/css';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';

export const collapseRow = sx({
  display: 'flex',
  alignItems: 'center',
  gap: '1.5',
  cursor: 'pointer',
  color: 'fgPassive',
  userSelect: 'none',
});

/**
 * Keyboard focus for a quiet text row: the text comes up to full strength over
 * a 2px accent underline. Rows sit in containers that clip (`overflow: hidden`
 * keeps measured heights honest), so a ring outside the row would be cut off and
 * an inset ring would touch the first glyph; the underline stays inside the row.
 */
export const focusUnderline = {
  outline: 'none',
  color: vars.fg,
  textDecorationLine: 'underline',
  textDecorationColor: vars.focusRing,
  textDecorationThickness: '2px',
  textUnderlineOffset: '5px',
} as const;

/**
 * A folded run of work reads as one quiet line ("Thought for 4s ›"): passive
 * text that comes up to the muted tone on hover, a focus ring for the keyboard,
 * no fill and no box.
 */
export const collapseRowHover = style({
  transition: 'color 150ms',
  outline: 'none',
  selectors: {
    '&:hover': { color: vars.fgMuted },
    '&:focus-visible': focusUnderline,
  },
});

/** Combined class for the header row element. */
export const collapseHeader = style([
  collapseRow,
  collapseRowHover,
  { fontSize: vars.typeBodyFontSize },
]);

export const chevron = style({
  display: 'inline-block',
  fontSize: '0.875rem',
  transition: 'transform 150ms ease-out',
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const chevronExpanded = style({
  transform: 'rotate(90deg)',
});
