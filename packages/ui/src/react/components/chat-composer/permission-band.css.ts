import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A permission request at the top of the composer field: the needs-you mark, the request in
// words, a caption, and the decision on the right. It wraps under the words in a narrow pane.

export const band = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: '0.625rem',
  rowGap: '0.5rem',
  minWidth: 0,
  paddingTop: '0.625rem',
  paddingBottom: '0.625rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.625rem',
  color: vars.foreground,
});

/** The mark sits level with the first line of the request. */
export const glyph = style({
  display: 'flex',
  alignSelf: 'flex-start',
  height: '1.25rem',
  alignItems: 'center',
  flexShrink: 0,
});

export const text = style({
  flex: '1 1 12rem',
  minWidth: 0,
});

export const title = style({
  margin: 0,
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflowWrap: 'anywhere',
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
  fontWeight: 500,
  color: vars.foreground,
});

export const meta = style({
  margin: 0,
  marginTop: '0.125rem',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundPassive,
});

export const counter = style({
  fontVariantNumeric: 'tabular-nums',
});

export const action = style({
  flexShrink: 0,
  marginLeft: 'auto',
  maxWidth: '100%',
});
