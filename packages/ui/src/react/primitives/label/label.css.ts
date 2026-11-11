import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/**
 * Shared label typography — the single styling source for both the standalone
 * `Label` and `Field.Label` (field.css.ts composes this). Field / row label role:
 * 13px in full strength (design brief 2.4).
 */
export const labelBase = style({
  fontSize: tokenVars.textSm,
  fontWeight: 400,
  lineHeight: 1.3,
  color: vars.foreground,
  selectors: {
    '&[data-disabled]': { cursor: 'not-allowed', opacity: 0.7 },
  },
});

export const label = style([
  labelBase,
  {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    userSelect: 'none',
  },
]);

/** Group-label role (the sidebar's section label): 11px passive, sentence case. */
export const microLabel = style({
  fontFamily: tokenVars.fontSans,
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundPassive,
  cursor: 'default',
  userSelect: 'none',
});
