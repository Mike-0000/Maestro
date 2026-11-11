import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { kfFadeIn, kfFadeOut, kfPopupIn, kfPopupOut } from '@styles/effects/animations.css';
import { recipesLayer } from '@styles/layers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// Dialogs (design brief 2.9): the elevated surface, rounded-xl, one hairline,
// a soft overlay shadow (black in dark, ink in light) over a plain scrim, no
// blur. Title in the dialog-title role, 24px padding, no rules: the header,
// body and footer separate by space.

const reducedMotion = {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      selectors: { '&[data-open], &[data-closed]': { animation: 'none' } },
    },
  },
} as const;

export const overlay = style({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  backgroundColor: vars.backdrop,
  selectors: {
    '&[data-open]': { animation: `${kfFadeIn} 150ms ease-out both` },
    '&[data-closed]': { animation: `${kfFadeOut} 120ms ease-in both` },
  },
  ...reducedMotion,
});

/** Full-viewport grid that centers the popup without using transform on the popup itself. */
export const positioner = style({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  padding: '1rem',
  pointerEvents: 'none',
});

export const content = recipe({
  base: {
    pointerEvents: 'auto',
    zIndex: 50,
    display: 'flex',
    maxHeight: '100%',
    width: '100%',
    maxWidth: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: tokenVars.radiusXl,
    backgroundColor: vars.surface,
    fontSize: tokenVars.textSm,
    lineHeight: tokenVars.textSmLineHeight,
    color: vars.foreground,
    boxShadow: `${vars.shadowOverlay}, 0 0 0 1px ${vars.borderSubtle}`,
    outline: 'none',
    selectors: {
      '&[data-open]': { animation: `${kfPopupIn} 150ms cubic-bezier(0.22, 1, 0.36, 1) both` },
      '&[data-closed]': { animation: `${kfPopupOut} 120ms ease-in both` },
    },
    ...reducedMotion,
  },
  variants: {
    // sm 400 (confirm), md 520 (default form), lg 680 (create / integrate / add
    // project); xs and the two oversized pickers keep their old meaning.
    size: {
      xs: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '20rem' } } },
      sm: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '25rem' } } },
      md: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '32.5rem' } } },
      lg: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '42.5rem' } } },
      xl: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '80vw', height: '80vh' } } },
      // Near-fullscreen: fills the positioner (viewport minus its 1rem padding).
      full: { height: '100%' },
    },
  },
  defaultVariants: { size: 'md' },
});

export const header = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1.5rem 1.5rem 0',
});

export const headerInner = style({
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: '0.375rem',
});

export const footer = style({
  display: 'flex',
  flexShrink: 0,
  flexDirection: 'column-reverse',
  alignItems: 'stretch',
  gap: '0.5rem',
  padding: '0 1.5rem 1.5rem',
  selectors: {
    // A header-only dialog (a bare confirm): keep the title off the buttons.
    '[data-slot="dialog-header"] + &': { paddingTop: '1.5rem' },
    // Under a ModalLayout middle that scrolls: a little air between its fading edge and the buttons.
    '[data-slot="animated-height"][data-overflowing] + &': { paddingTop: '0.75rem' },
  },
  '@media': {
    '(min-width: 640px)': {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
  },
});

/** Dialog-title role: 16px semibold. */
export const title = style({
  margin: 0,
  fontSize: tokenVars.textLg,
  lineHeight: tokenVars.textLgLineHeight,
  fontWeight: 600,
  letterSpacing: '-0.005em',
  color: vars.foreground,
  textWrap: 'balance',
});

/** One sentence under the title, in the muted tone. */
export const description = style({
  margin: 0,
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
  color: vars.foregroundMuted,
  textWrap: 'pretty',
});
globalStyle(`${description} a`, {
  color: vars.link,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  textDecorationColor: `color-mix(in srgb, ${vars.link} 40%, transparent)`,
});
globalStyle(`${description} a:hover`, {
  textDecorationColor: vars.link,
});

/**
 * In `@layer recipes`, so app utilities (`gap-4`, `p-0`, `px-6`) shape a body
 * without inline styles. Its scroll and fade come from the unlayered
 * `.scroll-fade__viewport` class, which sets only overflow and the mask.
 */
export const body = style({
  '@layer': {
    [recipesLayer]: {
      display: 'flex',
      width: '100%',
      flexDirection: 'column',
      gap: '1.25rem',
      padding: '1.25rem 1.5rem 1.5rem',
      outline: 'none',
      selectors: {
        '&:focus-visible': { outline: 'none' },
      },
    },
  },
});

export const closeButtonOverride = style({
  marginTop: '-0.25rem',
  marginRight: '-0.5rem',
  flexShrink: 0,
  color: vars.foregroundPassive,
  selectors: {
    '&:hover': { color: vars.foreground },
  },
});
