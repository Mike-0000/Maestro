import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

export const radioGroup = style({
  display: 'grid',
  width: '100%',
  gap: '0.75rem',
});

export const radioItem = style({
  position: 'relative',
  display: 'inline-flex',
  width: '1rem',
  height: '1rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${vars.border2}`,
  borderRadius: '9999px',
  backgroundColor: 'transparent',
  outline: 'none',
  transition: 'background-color 150ms, border-color 150ms, box-shadow 150ms',
  selectors: {
    '&:hover': { borderColor: vars.foregroundMuted },
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '2px',
    },
    // Checked: a neutral filled disc with an inverse centre, like the checkbox.
    '&[data-checked]': {
      borderColor: vars.backgroundNeutral,
      backgroundColor: vars.backgroundNeutral,
    },
    '&[data-disabled]': {
      pointerEvents: 'none',
      opacity: 0.5,
    },
    '&[data-invalid], &[aria-invalid="true"]': {
      borderColor: vars.borderDestructive,
    },
  },
});

export const radioIndicator = style({
  display: 'flex',
  width: '100%',
  height: '100%',
  alignItems: 'center',
  justifyContent: 'center',
});

export const radioIndicatorDot = style({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '9999px',
  backgroundColor: vars.foregroundNeutral,
});

globalStyle(`${radioItem} input[type="radio"]`, {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
});
