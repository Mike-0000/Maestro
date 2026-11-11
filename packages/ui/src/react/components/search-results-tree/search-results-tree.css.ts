import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const root = style({
  display: 'flex',
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  flexDirection: 'column',
  overflow: 'hidden',
});

export const viewport = style({
  height: '100%',
  padding: '0 0.5rem 0.5rem',
});

export const fileIcon = style({
  display: 'inline-flex',
  width: '14px',
  height: '14px',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foregroundPassive,
});

export const devicon = style({
  display: 'inline-block',
  width: '12px',
  height: '12px',
  flexShrink: 0,
  fontSize: '12px',
  lineHeight: '12px',
});

export const fileName = style({
  flexShrink: 0,
  fontWeight: 500,
});

export const count = style({
  marginLeft: 'auto',
  flexShrink: 0,
  fontSize: tokenVars.textTiny,
  color: vars.foregroundPassive,
  fontVariantNumeric: 'tabular-nums',
});

export const matchRow = style({
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textXs,
});

export const lineNumber = style({
  width: '3rem',
  flexShrink: 0,
  paddingRight: '0.5rem',
  textAlign: 'right',
  color: vars.foregroundPassive,
  fontVariantNumeric: 'tabular-nums',
});

export const preview = style({
  minWidth: 0,
  flex: '1 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
});

// Match highlight: the amber solid at low strength, so it reads in both themes.
export const highlight = style({
  borderRadius: '2px',
  backgroundColor: `color-mix(in srgb, ${vars.foregroundDiffModified} 32%, transparent)`,
  color: vars.foreground,
});
