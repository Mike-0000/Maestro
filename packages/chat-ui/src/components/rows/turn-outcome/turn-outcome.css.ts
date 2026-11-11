import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** How a turn ended. Quiet unless it failed. Height is set inline (the measured rowH). */
export const outcomeRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
});

/** A turn that ended normally, was cancelled or interrupted: a small centred marker. */
export const outcomeQuiet = style({
  justifyContent: 'center',
  color: vars.fgPassive,
  fontSize: '0.75rem',
  textAlign: 'center',
});

/** A turn that failed: the error dot and the words, in the error tone. Unmissable, not loud. */
export const outcomeError = style({
  color: vars.fgError,
  fontSize: vars.typeBodyFontSize,
});

export const outcomeErrorDot = style({
  width: '8px',
  height: '8px',
  flexShrink: 0,
  borderRadius: vars.radiusFull,
  background: vars.fgError,
});

export const outcomeText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
