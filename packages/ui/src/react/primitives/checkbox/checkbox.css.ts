import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A checkbox is findable by its edge (border-2, >= 3:1 on every surface) and
// checked reads as a filled neutral box with an inverse tick, never accent.
// Keyboard focus draws the shared accent outline.

export const root = style({
  position: 'relative',
  display: 'flex',
  width: '1rem',
  height: '1rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: tokenVars.radiusXs,
  border: `1px solid ${vars.border2}`,
  backgroundColor: 'transparent',
  color: vars.foreground,
  outline: 'none',
  transition: 'border-color 150ms, background-color 150ms',
  selectors: {
    // Enlarged hit target: clicks land on the ::after box, not just the 1rem square.
    '&::after': {
      content: '""',
      position: 'absolute',
      top: '-0.5rem',
      bottom: '-0.5rem',
      left: '-0.75rem',
      right: '-0.75rem',
    },
    '&:hover': { borderColor: vars.foregroundMuted },
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '2px',
    },
    '&[data-checked], &[data-indeterminate]': {
      borderColor: vars.backgroundNeutral,
      backgroundColor: vars.backgroundNeutral,
      color: vars.foregroundNeutral,
    },
    // base-ui sets data-disabled both for a direct `disabled` prop and when the
    // checkbox sits inside a disabled Field — this covers the legacy
    // group-has-disabled/field dimming.
    '&[data-disabled]': {
      cursor: 'not-allowed',
      opacity: 0.5,
    },
    '&[data-invalid]': {
      borderColor: vars.borderDestructive,
    },
  },
});

export const indicator = style({
  display: 'grid',
  placeContent: 'center',
  color: 'currentColor',
});

globalStyle(`${indicator} svg`, {
  width: '0.75rem',
  height: '0.75rem',
  pointerEvents: 'none',
});
