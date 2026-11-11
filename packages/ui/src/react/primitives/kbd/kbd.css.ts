import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A quiet keycap (design brief 2.13.11): 10px medium text on one neutral step,
// rounded-xs, no rim by default. Hosts adapt it through the --kbd-bg,
// --kbd-border and --kbd-color hooks (Button, Tooltip and the app shortcut chip
// set them).
export const kbd = style({
  pointerEvents: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  minWidth: '1.125rem',
  height: '1.125rem',
  paddingInline: '0.25rem',
  borderRadius: tokenVars.radiusXs,
  border: '1px solid var(--kbd-border, transparent)',
  backgroundColor: `var(--kbd-bg, color-mix(in srgb, ${vars.foreground} 7%, transparent))`,
  color: `var(--kbd-color, ${vars.foregroundMuted})`,
  fontFamily: tokenVars.fontSans,
  fontSize: tokenVars.textMicro,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
  userSelect: 'none',
});

globalStyle(`${kbd} svg:not([class*='size-'])`, {
  width: '0.75rem',
  height: '0.75rem',
});

export const kbdGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.125rem',
});
