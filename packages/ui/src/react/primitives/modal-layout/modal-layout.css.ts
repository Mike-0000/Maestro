import { style } from '@vanilla-extract/css';

/** Left side of a dialog footer: extra links as text actions, pushed away from the buttons. */
export const leading = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: '1.25rem',
  rowGap: '0.5rem',
  marginRight: 'auto',
});
