import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const description = style({
  margin: 0,
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
  color: vars.foregroundMuted,
  textWrap: 'pretty',
});
