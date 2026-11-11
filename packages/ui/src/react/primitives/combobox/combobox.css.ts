import { globalStyle, style } from '@vanilla-extract/css';
import { svgDefaultSize } from '@styles/effects/svg-helpers.css';
import { recipesLayer } from '@styles/layers.css';
import { fieldFocusRing } from '@styles/recipes/field-shell.css';
import { menuGroupLabel, menuItemBase, menuSeparatorLine } from '@styles/recipes/menu-item.css';
import { popupSurface, popupShadowSm } from '@styles/recipes/popup-surface.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

export const comboboxTrigger = style([svgDefaultSize, {}]);

/** `appearance="input"`: the value truncates; the field takes the width its caller gives it. */
export const comboboxTriggerInput = style({
  '@layer': { [recipesLayer]: { minWidth: 0 } },
  selectors: {
    '&[aria-invalid="true"]': { borderColor: vars.borderDestructive, boxShadow: 'none' },
  },
});

export const comboboxContent = style([
  popupSurface,
  popupShadowSm,
  {
    maxHeight: 'var(--available-height)',
    maxWidth: 'var(--available-width)',
    overflow: 'hidden',
    padding: '0.25rem',
    selectors: {
      '&[data-width="trigger"]': {
        width: 'var(--anchor-width)',
        minWidth: 'var(--anchor-width)',
      },
      '&[data-width="content"]': {
        width: 'max-content',
        minWidth: '11.25rem',
      },
      '&[data-width="content-at-least-trigger"]': {
        width: 'max-content',
        minWidth: 'max(11.25rem, var(--anchor-width))',
      },
    },
  },
]);

/** Outer wrapper that ScrollContainer renders — position context for the fade overlay. */
export const comboboxListScroller = style({});

/**
 * Applied to the scroll viewport inside ScrollContainer.
 * overscrollBehavior must be on the actual scrolling element.
 */
export const comboboxListViewport = style({
  overscrollBehavior: 'contain',
});

export const comboboxList = style({
  scrollPaddingTop: '0.25rem',
  scrollPaddingBottom: '0.25rem',
});

export const comboboxItem = style([
  menuItemBase({ trailingIndicator: true, fullWidth: true }),
  {
    selectors: {
      // The chosen value reads at full strength with its check; only the
      // highlighted row takes a fill.
      '&[data-selected]': { color: vars.foreground },
      '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
      '&[data-disabled][data-hoverable-when-disabled]': {
        pointerEvents: 'auto',
        cursor: 'not-allowed',
      },
    },
  },
]);

export const comboboxItemIndicator = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  width: '0.875rem',
  height: '0.875rem',
  alignItems: 'center',
  justifyContent: 'center',
  color: vars.foreground,
});

export const comboboxLabel = menuGroupLabel;

export const comboboxEmpty = style({
  display: 'none',
  width: '100%',
  justifyContent: 'center',
  paddingTop: '0.75rem',
  paddingBottom: '0.75rem',
  textAlign: 'center',
  fontSize: tokenVars.textSm,
  color: vars.foregroundPassive,
  selectors: {
    // show when data-empty is on the parent popup
    '[data-slot="combobox-content"][data-empty] &': {
      display: 'flex',
    },
  },
});

export const comboboxSeparator = style([
  menuSeparatorLine,
  { marginLeft: '-0.25rem', marginRight: '-0.25rem' },
]);

export const comboboxChips = style({
  display: 'flex',
  minHeight: '2.25rem',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceInput,
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textSm,
  transition: 'color 150ms, box-shadow 150ms, border-color 150ms',
  selectors: {
    '&:hover': { borderColor: vars.border1 },
    '&:focus-within': fieldFocusRing,
    '&:has([aria-invalid="true"])': { borderColor: vars.borderDestructive },
    '&:has([data-slot="combobox-chip"])': {
      paddingLeft: '0.375rem',
    },
  },
});

export const comboboxChip = style({
  display: 'flex',
  height: '1.375rem',
  width: 'fit-content',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: `color-mix(in srgb, ${vars.foreground} 8%, transparent)`,
  paddingLeft: '0.375rem',
  paddingRight: '0.375rem',
  fontSize: tokenVars.textXs,
  fontWeight: 400,
  whiteSpace: 'nowrap',
  color: vars.foreground,
  selectors: {
    '&:has([disabled])': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
    '&:has([data-slot="combobox-chip-remove"])': { paddingRight: 0 },
  },
});

export const comboboxChipRemove = style({
  marginLeft: '-0.25rem',
  opacity: 0.5,
  selectors: {
    '&:hover': { opacity: 1 },
  },
});

export const comboboxChipsInput = style({
  minWidth: '4rem',
  flex: 1,
  outline: 'none',
});

/**
 * Applied to the trigger InputGroupButton inside ComboboxInput.
 * Hides when a sibling combobox-clear button is present; clears pressed bg.
 */
export const triggerButtonHideIfClear = style({
  selectors: {
    '&[data-pressed]': { backgroundColor: 'transparent' },
  },
});
globalStyle(
  `[data-slot="input-group"]:has([data-slot="combobox-clear"]) ${triggerButtonHideIfClear}`,
  { display: 'none' }
);
