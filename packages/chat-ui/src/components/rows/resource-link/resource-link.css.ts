import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type ResourceLinkStyleVars = { rowH: number };

export const resourceLinkVars = createVariableThemeContract<ResourceLinkStyleVars>({ rowH: null });

export const resourceLinkRoot = style({
  height: resourceLinkVars.rowH,
  display: 'flex',
  alignItems: 'stretch',
});

const rowBase = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: vars.typeBodyFontSize,
  height: '100%',
});

export const rowStatic = rowBase;

/**
 * A link the agent shared: a quiet row, not a box. It pulls out by its padding
 * so the icon lines up with the transcript text and the hover fill has room.
 */
export const rowClickable = style([
  rowBase,
  {
    cursor: 'pointer',
    padding: '0 8px',
    marginLeft: '-8px',
    marginRight: '-8px',
    borderRadius: vars.radiusMd,
    width: 'calc(100% + 16px)',
    outline: 'none',
    transition: 'background-color 150ms, color 150ms',
    selectors: {
      '&:hover': {
        background: vars.surfaceHover,
      },
      '&:focus-visible': {
        boxShadow: `inset 0 0 0 1px ${vars.focusRing}`,
      },
    },
  },
]);

export const iconWrap = style({
  display: 'inline-flex',
  alignItems: 'center',
  color: vars.fgPassive,
  flexShrink: 0,
});
export const titleText = style({
  color: vars.fg,
  flexShrink: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
export const pathText = style({
  color: vars.fgPassive,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '0.75rem',
});
export const sizeText = style({
  color: vars.fgPassive,
  fontVariantNumeric: 'tabular-nums',
  flexShrink: 0,
  fontSize: '0.75rem',
  fontWeight: 400,
});
