import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** "Working…" with the pulsing accent dot of the state language. Height set inline. */
export const workingRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  color: vars.fgPassive,
  fontSize: vars.typeBodyFontSize,
  userSelect: 'none',
});
