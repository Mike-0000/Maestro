import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { LIGHT_THEME_SCOPE } from '@styles/recipes/field-shell.css';
import { vars } from '@theme/core/contract/contract.css';

// A switch (design brief 2.8): the off track is the findable control edge tone
// (border-1), on is the accent; the thumb is a near-white knob in both themes
// (a soft shadow lifts it off the track in light). Keyboard focus draws the
// shared accent outline.

// Pre-created base so the thumb and hidden-input selectors can reference it.
const switchBase = style({
  display: 'inline-flex',
  position: 'relative',
  flexShrink: 0,
  cursor: 'pointer',
  borderRadius: '9999px',
  border: '1px solid transparent',
  outline: 'none',
  transition: 'background-color 150ms, border-color 150ms',
  backgroundColor: vars.border1,
  selectors: {
    '&:hover': { backgroundColor: vars.border2 },
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '2px',
    },
    '&[data-checked]': {
      backgroundColor: vars.primaryButtonBackground,
    },
    '&[data-checked]:hover': {
      backgroundColor: vars.primaryButtonBackgroundHover,
    },
    '&[data-disabled]': {
      pointerEvents: 'none',
      opacity: 0.5,
    },
  },
});

export const switchRoot = recipe({
  base: switchBase,
  variants: {
    size: {
      base: { width: '2rem', height: '1.125rem' },
      sm: { width: '1.5rem', height: '0.875rem' },
    },
  },
  defaultVariants: { size: 'base' },
});

export type SwitchVariants = NonNullable<RecipeVariants<typeof switchRoot>>;

export const switchThumb = style({
  position: 'absolute',
  top: '50%',
  left: '0.125rem',
  transform: 'translateY(-50%)',
  width: '0.75rem',
  height: '0.75rem',
  borderRadius: '9999px',
  backgroundColor: vars.foreground,
  transition: 'left 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  pointerEvents: 'none',
  selectors: {
    [`${LIGHT_THEME_SCOPE} &`]: {
      backgroundColor: vars.surfaceElevated,
      boxShadow: `0 1px 2px color-mix(in srgb, ${vars.foreground} 25%, transparent)`,
    },
    [`${switchBase}[data-checked] &`]: {
      left: 'calc(100% - 0.125rem - 0.75rem)',
    },
    [`${switchBase}[data-size="sm"] &`]: {
      width: '0.625rem',
      height: '0.625rem',
    },
    [`${switchBase}[data-size="sm"][data-checked] &`]: {
      left: 'calc(100% - 0.125rem - 0.625rem)',
    },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

// Ensure the hidden input doesn't affect layout
globalStyle(`${switchBase} input[type="checkbox"]`, {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
});
