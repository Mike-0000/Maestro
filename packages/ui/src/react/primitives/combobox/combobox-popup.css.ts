import { globalStyle, style } from '@vanilla-extract/css';
import { popupHairline, popupMotion } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const popupPositioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

// The floating surface every popup shares (brief 2.10): elevated, rounded-lg, one hairline.
export const popupRoot = style([
  popupMotion,
  {
    minWidth: 'min(220px, var(--available-width))',
    maxWidth: 'min(340px, var(--available-width))',
    transformOrigin: 'var(--transform-origin)',
    overflow: 'hidden',
    outline: 'none',
    borderRadius: tokenVars.radiusLg,
    backgroundColor: vars.surface,
    color: vars.foreground,
    boxShadow: `${vars.shadowSm}, ${popupHairline}`,
  },
]);

export const popupRootWide = style({
  width: 'min(30rem, var(--available-width))',
  maxWidth: 'var(--available-width)',
});

// A caption over the list, separated by space rather than a rule.
export const popupHeader = style({
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.125rem',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundPassive,
});

export const popupList = style({
  maxHeight: '240px',
  scrollPaddingTop: '0.25rem',
  scrollPaddingBottom: '0.25rem',
  overflowY: 'auto',
  padding: '0.25rem',
});

export const popupItem = style({
  position: 'relative',
  display: 'flex',
  width: '100%',
  cursor: 'default',
  userSelect: 'none',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2rem',
  borderRadius: tokenVars.radiusMd,
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  paddingLeft: '0.5rem',
  paddingRight: '2rem',
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
  outline: 'none',
});

export const popupItemStacked = style({
  alignItems: 'flex-start',
  paddingRight: '0.5rem',
});

export const popupItemTextStack = style({
  display: 'flex',
  minWidth: 0,
  flex: '1 1 0%',
  flexDirection: 'column',
  gap: '0.125rem',
});

export const popupItemDefault = style({
  color: vars.foreground,
  textAlign: 'center',
});

export const popupSectionHeader = style({
  paddingTop: '0.5rem',
  paddingBottom: '0.25rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  fontSize: tokenVars.textTiny,
  fontWeight: 400,
  color: vars.foregroundPassive,
});

export const popupItemHighlighted = style({
  backgroundColor: vars.surfaceHover,
  color: vars.foreground,
});

export const popupItemHover = style({
  color: vars.foreground,
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
  },
});

export const popupItemIcon = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  fontSize: '1em',
});
globalStyle(`${popupItemIcon} svg`, { width: '1rem', height: '1rem' });

export const popupItemLabel = style({
  // Keep the primary label visible before allowing the description/path to take space.
  flexGrow: 1,
  flexShrink: 0,
  flexBasis: 'auto',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const popupItemDescription = style({
  // High flex-shrink so the muted description ellipsizes before the (short)
  // primary label, keeping the command/mention name visible.
  flexGrow: 0,
  flexShrink: 100,
  flexBasis: 'auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const popupDismiss = style({
  display: 'inline-flex',
  width: '1rem',
  height: '1rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusSm,
  opacity: 0.5,
  selectors: {
    '&:hover': { opacity: 1 },
  },
});
