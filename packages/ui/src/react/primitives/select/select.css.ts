import { globalStyle, style } from '@vanilla-extract/css';
import { menuGroupLabel, menuItemBase, menuSeparatorLine } from '@styles/recipes/menu-item.css';
import { popupShadowMd, popupSurface } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

export const selectGroup = style({
  scrollMarginTop: '0.25rem',
  scrollMarginBottom: '0.25rem',
});

export const selectValue = style({
  display: 'flex',
  flex: 1,
  textAlign: 'left',
});

// Same floating surface as every menu (brief 2.10).
export const selectContent = style([
  popupSurface,
  popupShadowMd,
  {
    isolation: 'isolate',
    zIndex: 50,
    maxHeight: 'var(--available-height)',
    maxWidth: 'var(--available-width)',
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: '0.25rem',
    selectors: {
      '&[data-width="trigger"]': {
        width: 'var(--anchor-width)',
        minWidth: 'var(--anchor-width)',
      },
      '&[data-width="content"]': {
        width: 'max-content',
        minWidth: '9rem',
      },
      '&[data-width="content-at-least-trigger"]': {
        width: 'max-content',
        minWidth: 'max(9rem, var(--anchor-width))',
      },
      // When aligned with trigger, skip the popup animation
      '&[data-align-trigger="true"]': { animation: 'none' },
    },
  },
]);

export const selectLabel = menuGroupLabel;

// The chosen value reads at full strength with a check; the row takes no fill.
export const selectItem = style([
  menuItemBase({ trailingIndicator: true, fullWidth: true }),
  {
    selectors: {
      '&[data-selected]': { color: vars.foreground },
    },
  },
]);

export const selectItemText = style({
  display: 'flex',
  minWidth: 0,
  flex: 1,
  alignItems: 'center',
  gap: '0.5rem',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

export const selectItemIndicator = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  width: '1rem',
  height: '1rem',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foreground,
});

export const selectSeparator = style([
  menuSeparatorLine,
  {
    pointerEvents: 'none',
    marginLeft: '-0.25rem',
    marginRight: '-0.25rem',
  },
]);

export const scrollButton = style({
  zIndex: 10,
  display: 'flex',
  width: '100%',
  cursor: 'default',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: vars.surface,
  color: vars.foregroundPassive,
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
});
globalStyle(`${scrollButton} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

// Invalid: the edge turns destructive; the message under the field carries the words.
export const triggerInvalidOverride = style({
  selectors: {
    '&[aria-invalid="true"]': {
      borderColor: vars.borderDestructive,
      boxShadow: 'none',
    },
  },
});
