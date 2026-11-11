import { style } from '@vanilla-extract/css';
import { focusUnderline } from '@components/primitives/collapse-header.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

export type SubagentStyleVars = {
  height: number;
};

export const subagentVars = createVariableThemeContract<SubagentStyleVars>({
  height: null,
});

export const subagentRoot = style({
  height: subagentVars.height,
  overflow: 'hidden',
  color: vars.fgPassive,
  userSelect: 'none',
});

export const subagentHeader = style({
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '2px',
});

export const subagentNameRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
});

export const subagentIndicator = style({
  width: '16px',
  height: '16px',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.fgMuted,
  lineHeight: 1,
});

export const subagentDot = style({
  width: '8px',
  height: '8px',
  borderRadius: vars.radiusFull,
});

/** Finished: the passive ring of the state language. */
export const subagentDotCompleted = style([
  subagentDot,
  {
    border: `1.5px solid ${vars.fgPassive}`,
  },
]);

/** Stopped on an error: the filled error dot. */
export const subagentDotFailed = style([
  subagentDot,
  {
    background: vars.fgError,
  },
]);

export const subagentName = style({
  fontSize: vars.typeBodyFontSize,
  color: vars.fgMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
});

export const subagentStatusRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  height: '24px',
  marginLeft: '22px',
  minWidth: 0,
  flexShrink: 0,
  color: vars.fgPassive,
  fontSize: vars.typeBodyFontSize,
});

export const subagentStatusRowCollapsible = style({
  cursor: 'pointer',
  width: 'fit-content',
  outline: 'none',
  transition: 'color 150ms',
  selectors: {
    '&:hover': { color: vars.fgMuted },
    '&:focus-visible': focusUnderline,
  },
});

/** A failed subagent says so in the error tone. */
export const subagentStatusFailed = style({
  color: vars.fgError,
  selectors: {
    '&:hover, &:focus-visible': { color: vars.fgError },
  },
});

export const subagentChevron = style({
  display: 'inline-block',
  fontSize: '0.875rem',
  transition: 'transform 150ms ease-out',
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const subagentChevronExpanded = style({
  transform: 'rotate(90deg)',
});

export const subagentChildrenOffset = style({
  marginLeft: '22px',
});
