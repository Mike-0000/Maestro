import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

const statusMarkBase = style({
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
  fontSize: '0.75rem',
  lineHeight: 1,
  whiteSpace: 'nowrap',
  // Status words are the only colored text on a quiet row.
  WebkitTextFillColor: 'currentColor',
});

/** A step that failed: the error glyph and the word, in the error tone. */
export const statusMarkError = style([statusMarkBase, { color: vars.fgError }]);

/** A step waiting on the developer's permission: the warning glyph and the words. */
export const statusMarkWarning = style([statusMarkBase, { color: vars.fgWarning }]);
