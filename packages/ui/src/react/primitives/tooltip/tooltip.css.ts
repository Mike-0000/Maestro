import { style } from '@vanilla-extract/css';
import { popupHairline, popupMotion } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

// A tooltip is a small note, not a pill (brief 2.10): the elevated-emphasis
// surface, rounded-md, 12px text, one hairline, no arrow by default.
export const content = style([
  popupMotion,
  {
    position: 'relative',
    zIndex: 50,
    transformOrigin: 'var(--transform-origin)',
    display: 'inline-flex',
    width: 'fit-content',
    maxWidth: '20rem',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.25rem 0.5rem',
    borderRadius: tokenVars.radiusMd,
    backgroundColor: vars.surfaceElevatedEmphasis,
    color: vars.foreground,
    boxShadow: `${vars.shadowSm}, ${popupHairline}`,
    fontSize: tokenVars.textXs,
    lineHeight: tokenVars.textXsLineHeight,
    outline: 'none',
    vars: {
      // Kbd keycaps inside a tooltip sit one quiet step above its surface.
      '--kbd-bg': `color-mix(in srgb, ${vars.foreground} 8%, transparent)`,
      '--kbd-border': 'transparent',
      '--kbd-color': vars.foregroundMuted,
    },
  },
]);

export const arrow = style({
  zIndex: 50,
  width: '0.625rem',
  height: '0.625rem',
  borderRadius: '2px',
  backgroundColor: vars.surfaceElevatedEmphasis,
  transform: 'translateY(calc(-50% - 2px)) rotate(45deg)',
  selectors: {
    '&[data-side="bottom"]': { top: '0.25rem' },
    '&[data-side="top"]': { bottom: '-0.625rem' },
    '&[data-side="left"], &[data-side="inline-start"]': {
      top: '50%',
      right: '-0.25rem',
      transform: 'translateY(-50%) rotate(45deg)',
    },
    '&[data-side="right"], &[data-side="inline-end"]': {
      top: '50%',
      left: '-0.25rem',
      transform: 'translateY(-50%) rotate(45deg)',
    },
  },
});
