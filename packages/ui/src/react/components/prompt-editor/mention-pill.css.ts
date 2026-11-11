import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// An inline @file / /command pill: the inline-code well (a quiet fill that works on any surface,
// rounded-xs, caption-sized text at full strength) with a passive glyph. On hover the glyph turns
// into a remove button. No outline, no colour beyond a file icon's own tint.

const pillFill = `color-mix(in srgb, ${vars.foreground} 8%, transparent)`;
const pillFillHover = `color-mix(in srgb, ${vars.foreground} 12%, transparent)`;

export const pillWrapper = style({
  display: 'inline-block',
  verticalAlign: 'baseline',
});

export const pill = style({
  position: 'relative',
  display: 'inline-flex',
  cursor: 'default',
  userSelect: 'none',
  alignItems: 'center',
  gap: '0.25rem',
  borderRadius: tokenVars.radiusXs,
  backgroundColor: pillFill,
  paddingLeft: '0.25rem',
  paddingRight: '0.3125rem',
  paddingTop: '0.0625rem',
  paddingBottom: '0.0625rem',
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  fontWeight: 400,
  color: vars.foreground,
  verticalAlign: 'baseline',
  transition: 'background-color 150ms',
  selectors: {
    '&:hover': { backgroundColor: pillFillHover },
  },
});

const pendingPulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.55 },
});

export const pillPending = style({
  animation: `${pendingPulse} 1.4s ease-in-out infinite`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
      opacity: 0.7,
    },
  },
});

export const pillIconArea = style({
  position: 'relative',
  display: 'flex',
  width: '0.875rem',
  height: '0.875rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foregroundPassive,
});

/** A devicon file glyph keeps its own tint (a file-type mark); sized to the pill. */
export const pillFileIcon = style({
  fontSize: '0.75rem',
  lineHeight: 1,
});

export const pillKindIcon = style({ width: '0.75rem', height: '0.75rem' });

/** The "/" before a command name. */
export const pillSlash = style({
  fontSize: tokenVars.textXs,
  fontWeight: 500,
  lineHeight: 1,
  color: vars.foregroundPassive,
});

export const pillRemoveBtn = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 'none',
  borderRadius: tokenVars.radiusXs,
  // Opaque twin of the hovered pill's fill, so the glyph underneath does not show through.
  backgroundColor: `color-mix(in srgb, ${vars.foreground} 12%, ${vars.surface})`,
  color: vars.foreground,
  opacity: 0,
  outline: 'none',
  transition: 'opacity 150ms',
  selectors: {
    [`${pill}:hover &`]: { opacity: 1 },
    '&:hover': { backgroundColor: `color-mix(in srgb, ${vars.foreground} 20%, ${vars.surface})` },
    '&:focus-visible': { opacity: 1, outline: `2px solid ${vars.focusRing}` },
  },
});

export const pillRemoveIcon = style({ width: '0.625rem', height: '0.625rem' });

export const pillName = style({
  maxWidth: '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
