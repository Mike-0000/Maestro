import { globalStyle, style } from '@vanilla-extract/css';
import { fadeSurface } from '@styles/effects.css';
import { vars } from '@styles/theme.css';

// ── Body ──────────────────────────────────────────────────────────────────────

/**
 * The command and its output: one well (emphasis surface, a hairline only in
 * light) under the quiet header. The 8px side margins take back the bare card's
 * pull-out, so the well lines up with the transcript text and code blocks.
 * Height + overflow are set inline (they depend on expanded state + bodyH).
 */
export const executeBody = style({
  position: 'relative',
  boxSizing: 'content-box',
  scrollbarWidth: 'thin',
  marginLeft: '8px',
  marginRight: '8px',
  borderRadius: vars.radiusMd,
  background: vars.surfaceEmphasis,
  boxShadow: `inset 0 0 0 1px ${vars.wellBorder}`,
  vars: { [fadeSurface]: vars.surfaceEmphasis },
});

globalStyle(`${executeBody}::-webkit-scrollbar`, {
  width: 'var(--execute-scrollbar-size)',
  height: 'var(--execute-scrollbar-size)',
});

// ── Header ────────────────────────────────────────────────────────────────────

/** Header title when it shows the command itself (no provider description). */
export const executeHeaderCommand = style({
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: vars.typeCodeFontSize,
  fontFamily: vars.typeCodeFontFamily,
});

// ── Line ──────────────────────────────────────────────────────────────────────

export const executeLine = style({
  whiteSpace: 'pre',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  color: vars.fg,
  // line-height is set via inline style from theme.fonts.code.lineHeight
  // so it cannot drift from the measured value via a CSS variable.
});

export const executeOutputLine = style({
  color: vars.fgMuted,
});

export const executeSpacerLine = style({
  userSelect: 'none',
});

export const executeTruncatedLine = style({
  color: vars.fgPassive,
  fontStyle: 'italic',
  userSelect: 'none',
});

globalStyle(`${executeLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${executeLine} span`, {
  color: 'var(--shiki-dark)',
});
