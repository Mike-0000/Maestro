import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A tile in a small set of mutually exclusive visual choices (colour mode,
// add-project mode). At rest it is a card one surface step up with a hairline;
// chosen, it takes the selected step, full-strength text and a findable
// neutral edge. Never accent (the accent marks focus, not choice).
export const selectableCard = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  border: `1px solid ${vars.borderSubtle}`,
  borderRadius: tokenVars.radiusLg,
  backgroundColor: vars.surfaceEmphasis,
  color: vars.foregroundMuted,
  transition: 'background-color 150ms, color 150ms, border-color 150ms',
  cursor: 'pointer',
  outline: 'none',
  selectors: {
    '&:hover': {
      backgroundColor: vars.surfaceEmphasisHover,
      color: vars.foreground,
    },
    '&[data-selected="true"], &[aria-selected="true"]': {
      backgroundColor: vars.surfaceEmphasisSelected,
      color: vars.foreground,
      borderColor: vars.border2,
    },
    '&[data-interactive="false"]': {
      color: vars.foregroundPassive,
      cursor: 'default',
    },
    '&[data-interactive="false"]:hover': {
      backgroundColor: vars.surfaceEmphasis,
      color: vars.foregroundPassive,
    },
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '2px',
    },
  },
});
