/**
 * menuItemBase — shared recipe for every row in a floating list: DropdownMenu,
 * ContextMenu, Select, Combobox and ComboboxPopup items (design brief 2.10).
 *
 * A row is 32px tall (min-height, so two-line rows grow), rounded-md, 8px side
 * padding, 13px text in the muted tone; leading icons are 16px and passive.
 * Highlighting (keyboard focus, `data-highlighted`, hover) lifts the row one
 * surface step and brings text and icon to full strength. Selected / checked
 * state is component-specific and composed on top.
 *
 * Variants:
 *   trailingIndicator — paddingRight 2rem, room for a check/radio indicator
 *   fullWidth         — width 100% (combobox and select items span the popup)
 *   inset             — paddingLeft 2rem (for inset label alignment)
 *   muted             — kept for compatibility; rows are muted by default now
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { svgContainer, svgDefaultSize } from '@styles/effects/svg-helpers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/** Highlight states shared by every popup row. */
export const MENU_ITEM_HIGHLIGHT = '&:focus, &[data-highlighted], &:hover:not([data-disabled])';

const menuItemRow = style([
  svgContainer,
  svgDefaultSize,
  {
    position: 'relative',
    display: 'flex',
    cursor: 'default',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '2rem',
    borderRadius: tokenVars.radiusMd,
    paddingTop: '0.375rem',
    paddingBottom: '0.375rem',
    paddingLeft: '0.5rem',
    paddingRight: '0.5rem',
    fontSize: tokenVars.textSm,
    lineHeight: tokenVars.textSmLineHeight,
    color: vars.foregroundMuted,
    outline: 'none',
    userSelect: 'none',
    transition: 'background-color 100ms, color 100ms',
    selectors: {
      [MENU_ITEM_HIGHLIGHT]: { backgroundColor: vars.surfaceHover, color: vars.foreground },
      '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
    },
  },
]);

// Leading icons sit in the passive tone and come up with the row's text.
// (`svg` here is the row's own icon; both elements are owned by the row.)
globalStyle(`${menuItemRow} > svg`, { color: vars.foregroundPassive, transition: 'color 100ms' });
globalStyle(
  `${menuItemRow}:focus > svg, ${menuItemRow}[data-highlighted] > svg, ${menuItemRow}:hover > svg`,
  { color: 'currentColor' }
);

export const menuItemBase = recipe({
  base: menuItemRow,

  variants: {
    trailingIndicator: {
      true: { paddingRight: '2rem' },
    },
    fullWidth: {
      true: { width: '100%' },
    },
    inset: {
      true: { paddingLeft: '2rem' },
    },
    muted: {
      true: { color: vars.foregroundMuted },
    },
  },

  defaultVariants: {
    trailingIndicator: false,
    fullWidth: false,
    inset: false,
    muted: false,
  },
});

export type MenuItemBaseVariants = RecipeVariants<typeof menuItemBase>;

/** Section label inside a popup list ("Recent", "Agents"): the group-label role. */
export const menuGroupLabel = style({
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.25rem',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  fontWeight: 400,
  color: vars.foregroundPassive,
  userSelect: 'none',
});

/** Separator between groups of rows: one subtle hairline with 4px air. */
export const menuSeparatorLine = style({
  marginTop: '0.25rem',
  marginBottom: '0.25rem',
  height: '1px',
  border: 'none',
  backgroundColor: vars.borderSubtle,
});

/** Trailing shortcut hint in a row: caption role. */
export const menuShortcutHint = style({
  marginLeft: 'auto',
  paddingLeft: '1rem',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundPassive,
  fontVariantNumeric: 'tabular-nums',
});
