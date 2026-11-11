import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/**
 * Alert root — the quiet notice (design brief 2.12 / 2.13.11): a card one
 * surface step up with one hairline, full-strength title and muted body. No
 * tinted fill and no coloured rim: the leading glyph carries the state, and
 * only an error or a warning colours it.
 */
export const alertRoot = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.625rem',
  borderRadius: tokenVars.radiusLg,
  border: `1px solid ${vars.borderSubtle}`,
  paddingTop: '0.75rem',
  paddingBottom: '0.75rem',
  paddingLeft: '0.875rem',
  paddingRight: '2.5rem',
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
  backgroundColor: vars.surfaceEmphasis,
  color: vars.foreground,
  selectors: {
    // Reserve room for the top-right action slot so text never runs under it.
    '&:has([data-slot=alert-action])': { paddingRight: '4.5rem' },
    // No dismiss and no action: no reserved gutter.
    '&:not(:has([data-slot=alert-action])):not(:has([data-slot=alert-dismiss]))': {
      paddingRight: '0.875rem',
    },
  },
});

export const alertIcon = style({
  display: 'flex',
  height: '1.25rem',
  alignItems: 'center',
  flexShrink: 0,
  color: vars.foregroundPassive,
  selectors: {
    [`${alertRoot}[data-status="destructive"] &`]: { color: vars.foregroundError },
    [`${alertRoot}[data-status="warning"] &`]: { color: vars.foregroundWarning },
  },
});
globalStyle(`${alertIcon} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const alertBody = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  minWidth: 0,
  flex: '1 1 0%',
});

export const alertTitle = style({
  margin: 0,
  fontWeight: 500,
  lineHeight: tokenVars.textSmLineHeight,
  color: vars.foreground,
});

export const alertDescription = style({
  margin: 0,
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
  selectors: {
    // A description on its own reads at body size.
    [`${alertBody} > &:only-child`]: {
      fontSize: tokenVars.textSm,
      lineHeight: tokenVars.textSmLineHeight,
      color: vars.foregroundBody,
    },
  },
});

/** Free-form action slot pinned to the top-right corner of the alert. */
export const alertAction = style({
  position: 'absolute',
  top: '0.5rem',
  right: '0.625rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
});

/** Dismiss button pinned to the top-right corner of the alert. */
export const alertDismiss = style({
  position: 'absolute',
  top: '0.5rem',
  right: '0.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.5rem',
  height: '1.5rem',
  borderRadius: tokenVars.radiusSm,
  border: 'none',
  backgroundColor: 'transparent',
  color: vars.foregroundPassive,
  cursor: 'pointer',
  transition: 'color 150ms, background-color 150ms',
  selectors: {
    '&:hover': {
      color: vars.foreground,
      backgroundColor: `color-mix(in srgb, ${vars.foreground} 8%, transparent)`,
    },
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '1px',
      color: vars.foreground,
    },
  },
});
globalStyle(`${alertDismiss} svg`, {
  pointerEvents: 'none',
  width: '0.875rem',
  height: '0.875rem',
});
