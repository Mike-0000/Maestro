/**
 * popupSurface — shared base style for floating popup containers.
 *
 * One look for every floating layer (design brief 2.10): menus, selects,
 * comboboxes, popovers, hover cards, toasts and tooltips sit on the elevated
 * surface (the component adds the `surface-elevated` scope class), with a 12px
 * radius and one hairline in `border-subtle`. In dark the shadow tokens draw
 * nothing, so the surface step plus the hairline carry the elevation; the
 * light theme keeps a soft shadow because a white popup on a white page needs
 * one.
 *
 * Each primitive extends this by composing it into its own `style()`:
 *   export const menuContent = style([popupSurface, popupShadowMd, { padding: '0.25rem' }]);
 *
 * Sizing (minWidth, overflowY, anchor-width usage) and shadow depth are
 * applied at the composing level, not here.
 */

import { style } from '@vanilla-extract/css';
import {
  kfPopupIn,
  kfPopupOut,
  kfPopupInSlideFromTop,
  kfPopupInSlideFromBottom,
  kfPopupInSlideFromLeft,
  kfPopupInSlideFromRight,
} from '@styles/effects/animations.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/** The hairline every floating layer draws around itself (as a box-shadow ring). */
export const popupHairline = `0 0 0 1px ${vars.borderSubtle}`;

const enter = '120ms cubic-bezier(0.22, 1, 0.36, 1) both';
const exit = '100ms ease-in both';

/** Entry / exit keyframes keyed to base-ui's data-open / data-closed / data-side. */
export const popupMotion = style({
  selectors: {
    '&[data-open]': { animation: `${kfPopupIn} ${enter}` },
    '&[data-open][data-side="bottom"]': { animation: `${kfPopupInSlideFromTop} ${enter}` },
    '&[data-open][data-side="top"]': { animation: `${kfPopupInSlideFromBottom} ${enter}` },
    '&[data-open][data-side="right"]': { animation: `${kfPopupInSlideFromLeft} ${enter}` },
    '&[data-open][data-side="inline-end"]': { animation: `${kfPopupInSlideFromLeft} ${enter}` },
    '&[data-open][data-side="left"]': { animation: `${kfPopupInSlideFromRight} ${enter}` },
    '&[data-open][data-side="inline-start"]': {
      animation: `${kfPopupInSlideFromRight} ${enter}`,
    },
    '&[data-closed]': { animation: `${kfPopupOut} ${exit}` },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      selectors: {
        '&[data-open], &[data-closed]': { animation: 'none' },
      },
    },
  },
});

const popupSurfaceBase = style([
  popupMotion,
  {
    position: 'relative',
    zIndex: 50,
    transformOrigin: 'var(--transform-origin)',
    borderRadius: tokenVars.radiusLg,
    outline: 'none',
  },
]);

export const popupSurface = style([
  popupSurfaceBase,
  {
    backgroundColor: vars.surface,
    color: vars.foreground,
    boxShadow: `${vars.shadowMd}, ${popupHairline}`,
  },
]);

/**
 * Inverted (neutral pill) tone — same structure and animations as
 * `popupSurface`, painted with the theme's inverted neutral slots. Kept for
 * compatibility; the kit's tooltip now uses the elevated-emphasis surface.
 */
export const popupSurfaceInverted = style([
  popupSurfaceBase,
  {
    backgroundColor: vars.backgroundNeutral,
    color: vars.foregroundNeutral,
  },
]);

/**
 * Shadow + hairline for popup containers.
 * - popupShadowSm: tooltips, comboboxes, hover cards
 * - popupShadowMd: menus, selects, popovers, toasts
 */
export const popupShadowSm = style({
  boxShadow: `${vars.shadowSm}, ${popupHairline}`,
});

export const popupShadowMd = style({
  boxShadow: `${vars.shadowMd}, ${popupHairline}`,
});
