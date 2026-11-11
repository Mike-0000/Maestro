import { globalStyle, style } from '@vanilla-extract/css';
import {
  menuGroupLabel,
  menuItemBase,
  menuSeparatorLine,
  menuShortcutHint,
} from '@styles/recipes/menu-item.css';
import { popupShadowMd, popupSurface } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
  outline: 'none',
});

// Elevated surface, rounded-lg, one hairline, 4px inner padding (brief 2.10).
export const menuContent = style([
  popupSurface,
  popupShadowMd,
  {
    zIndex: 50,
    maxHeight: 'var(--available-height)',
    maxWidth: 'var(--available-width)',
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: '0.25rem',
    selectors: {
      '&[data-width="trigger"]': {
        width: 'var(--anchor-width)',
        minWidth: '12rem',
      },
      '&[data-width="content"]': {
        width: 'max-content',
        minWidth: '12rem',
      },
      '&[data-width="content-at-least-trigger"]': {
        width: 'max-content',
        minWidth: 'max(12rem, var(--anchor-width))',
      },
      '&[data-slot="dropdown-menu-sub-content"][data-width="content"]': {
        minWidth: '6rem',
      },
      '&[data-closed]': { overflow: 'hidden' },
    },
  },
]);

export const menuLabel = style([
  menuGroupLabel,
  {
    selectors: {
      '&[data-inset]': { paddingLeft: '2rem' },
    },
  },
]);

export const menuItem = style([
  menuItemBase(),
  {
    selectors: {
      '&[data-inset]': { paddingLeft: '2rem' },
      '&[data-variant="destructive"]': { color: vars.foregroundDestructive },
      '&[data-variant="destructive"]:focus, &[data-variant="destructive"][data-highlighted]': {
        backgroundColor: vars.surfaceDestructiveHover,
        color: vars.foregroundDestructive,
      },
    },
  },
]);
globalStyle(`${menuItem}[data-variant="destructive"] > svg`, { color: 'currentColor' });

export const menuSubTrigger = style([
  menuItemBase(),
  {
    selectors: {
      '&[data-inset]': { paddingLeft: '2rem' },
      '&[data-popup-open]': { backgroundColor: vars.surfaceHover, color: vars.foreground },
      '&[data-open]': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    },
  },
]);

// Checkbox / radio rows: the check carries the state; the row itself only
// comes to full strength, it does not take a selected fill.
const choiceItem = {
  selectors: {
    '&[data-checked]': { color: vars.foreground },
    '&[data-inset]': { paddingLeft: '2rem' },
  },
} as const;

export const menuCheckboxItem = style([menuItemBase({ trailingIndicator: true }), choiceItem]);

export const menuRadioItem = style([menuItemBase({ trailingIndicator: true }), choiceItem]);

export const menuItemIndicator = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foreground,
});

// Full-bleed across the menu's 4px padding.
export const menuSeparator = style([
  menuSeparatorLine,
  { marginLeft: '-0.25rem', marginRight: '-0.25rem' },
]);

export const menuShortcut = style([
  menuShortcutHint,
  {
    // When the parent menu item is highlighted, the hint comes up a step.
    selectors: {
      '[data-slot="dropdown-menu-item"]:focus &': { color: vars.foregroundMuted },
      '[data-slot="dropdown-menu-item"][data-highlighted] &': { color: vars.foregroundMuted },
    },
  },
]);
