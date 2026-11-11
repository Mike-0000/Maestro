import { style } from '@vanilla-extract/css';
import { popupShadowMd, popupSurface } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

// The shared floating surface (brief 2.10) with room for arbitrary content.
export const popupContent = style([
  popupSurface,
  popupShadowMd,
  {
    zIndex: 50,
    display: 'flex',
    overflow: 'hidden',
    flexDirection: 'column',
    gap: '0.75rem',
    padding: '1rem',
    fontSize: tokenVars.textSm,
    lineHeight: tokenVars.textSmLineHeight,
  },
]);

export const popoverHeader = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  fontSize: tokenVars.textSm,
});

/** Section-title role: 13px semibold in full strength. */
export const popoverTitle = style({
  fontWeight: 600,
  color: vars.foreground,
});

/** Helper-text role under the title. */
export const popoverDescription = style({
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
});
