import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** GenericFileIcon: passive like the rest of a tool row's chrome, no flex shrink. */
export const genericFileIcon = style({
  color: vars.fgPassive,
  flexShrink: 0,
});
