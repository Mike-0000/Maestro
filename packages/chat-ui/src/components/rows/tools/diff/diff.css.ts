import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { textShimmer } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type DiffStyleVars = {
  height: number;
  headerH: number;
};

export const diffCardVars = createVariableThemeContract<DiffStyleVars>({
  height: null,
  headerH: null,
});

/**
 * A file edit reads as a quiet row ("model.ts +1 −0", opens the file) over a
 * well with the changed lines. Like a command, the row pulls out by its padding
 * so the file name lines up with the transcript text and the hover fill has
 * room; the well takes the pull-out back.
 */
export const diffRoot = style({
  height: diffCardVars.height,
  marginLeft: '-8px',
  marginRight: '-8px',
});

// ── DiffHeader ────────────────────────────────────────────────────────────────

export const diffHeader = recipe({
  base: {
    height: diffCardVars.headerH,
    // The edge keeps its measured width but draws nothing.
    border: '1px solid transparent',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '7px',
    paddingRight: '7px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    borderRadius: vars.radiusMd,
    color: vars.fgMuted,
    outline: 'none',
    transition: 'background-color 150ms, color 150ms',
    selectors: {
      '&:hover': { background: vars.surfaceHover, color: vars.fg },
      '&:focus-visible': { boxShadow: `inset 0 0 0 1px ${vars.focusRing}` },
    },
  },
  variants: {
    hasBody: {
      true: {
        borderBottom: 'none',
      },
      false: {},
    },
  },
});

export const diffFileName = style({
  color: 'inherit',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: vars.typeBodyFontSize,
});

export const diffAddsCount = style({
  color: vars.diffAdded,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
export const diffDelsCount = style({
  color: vars.diffDeleted,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
export const diffSpacer = style({ flex: '1 1 0%' });
export const diffFileIcon = style({
  flexShrink: 0,
  fontSize: '12px',
  lineHeight: 1,
});

// ── DiffLines body ────────────────────────────────────────────────────────────

/** The changed lines: a well like command output (the edge keeps its measured width). */
export const diffBodyCard = style({
  border: `1px solid ${vars.wellBorder}`,
  borderRadius: vars.radiusMd,
  background: vars.surfaceEmphasis,
  marginLeft: '8px',
  marginRight: '8px',
  overflow: 'hidden',
});

/**
 * Per-row classes — keyed by DiffRow type. Diffs keep their color (added /
 * removed tints are what a diff is), drawn as a soft tint plus a thin edge.
 */
export const diffRowClasses = {
  add: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffAdded} 12%, transparent)`,
    borderLeft: `2px solid ${vars.diffAdded}`,
  }),
  remove: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffDeleted} 12%, transparent)`,
    borderLeft: `2px solid ${vars.diffDeleted}`,
  }),
  context: style({
    display: 'flex',
    borderLeft: '2px solid transparent',
  }),
} as const;

export const diffLineContent = style({
  color: vars.fg,
  flex: '1 1 0%',
  overflow: 'hidden',
  paddingLeft: '10px',
  paddingRight: '12px',
});

// ── Shiki line styles ─────────────────────────────────────────────────────────

export const pdiffBody = style({
  position: 'relative',
});

export const pdiffLine = style({
  whiteSpace: 'pre',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  // line-height is set via inline style in Diff.tsx (from theme.fonts.code.lineHeight)
  // so it cannot drift from the measured value via a CSS variable.
});

globalStyle(`${pdiffLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${pdiffLine} span`, {
  color: 'var(--shiki-dark)',
});

export { textShimmer };
