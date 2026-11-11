import { globalStyle, style } from '@vanilla-extract/css';
import { recipesLayer } from '@styles/layers.css';
import { controlVariants } from '@styles/recipes/control.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/*
 * Every trigger style lives in `@layer recipes`, like the control recipe it
 * composes, so app Tailwind utilities and sx() sprinkles adjust a trigger
 * without inline styles. The row trigger's own rules follow the control
 * recipe in the same layer (this file imports it), so they win over it at
 * equal specificity.
 */

/**
 * variant="row" (default): full-width trigger button, a ghost control with
 * space-between so the chevron always pins to the trailing edge.
 */
export const trigger = style([
  controlVariants({ variant: 'ghost' }),
  {
    '@layer': {
      [recipesLayer]: {
        width: '100%',
        justifyContent: 'space-between',
        gap: '0.5rem',
        paddingLeft: '0.5rem',
        paddingRight: '0.5rem',
        fontWeight: 400,
        color: vars.foreground,
        selectors: {
          '&:hover': { color: vars.foreground },
        },
      },
    },
  },
]);

globalStyle(`${trigger} svg`, {
  '@layer': { [recipesLayer]: { pointerEvents: 'none', flexShrink: 0 } },
});

/**
 * variant="text": a quiet text disclosure — caption-size muted text with a
 * small leading chevron, no fill, no border, no button chrome. Hover brings the
 * text to full strength; keyboard focus draws the kit's accent outline. A
 * disabled text trigger reads as plain text (a notice with nothing behind it),
 * not as a dimmed control.
 */
export const triggerText = style({
  '@layer': {
    [recipesLayer]: {
      display: 'inline-flex',
      width: 'fit-content',
      alignItems: 'center',
      gap: '0.25rem',
      // Pull the hit area out by the padding so the text aligns with its column.
      marginLeft: '-0.25rem',
      marginRight: '-0.25rem',
      paddingLeft: '0.25rem',
      paddingRight: '0.25rem',
      border: 'none',
      borderRadius: tokenVars.radiusSm,
      backgroundColor: 'transparent',
      fontFamily: 'inherit',
      fontSize: tokenVars.textXs,
      lineHeight: tokenVars.textXsLineHeight,
      fontWeight: 400,
      textAlign: 'left',
      color: vars.foregroundMuted,
      cursor: 'default',
      outline: 'none',
      transition: 'color 150ms',
      selectors: {
        '&:hover:not(:disabled):not([data-disabled])': { color: vars.foreground },
        '&:focus-visible': {
          outline: `2px solid ${vars.focusRing}`,
          outlineOffset: '1px',
        },
      },
      '@media': {
        '(prefers-reduced-motion: reduce)': { transition: 'none' },
      },
    },
  },
});

/** Chevron rotates 180° when the panel is open (row trigger). */
export const chevron = style({
  '@layer': {
    [recipesLayer]: {
      transition: 'transform 200ms ease',
      selectors: {
        '[data-panel-open] &': { transform: 'rotate(180deg)' },
      },
    },
  },
});

/** Leading chevron of the text trigger: small, passive, turns to point down when open. */
export const chevronText = style({
  '@layer': {
    [recipesLayer]: {
      width: '0.75rem',
      height: '0.75rem',
      flexShrink: 0,
      pointerEvents: 'none',
      color: vars.foregroundPassive,
      transition: 'transform 150ms ease',
      selectors: {
        '[data-panel-open] > &': { transform: 'rotate(90deg)' },
      },
      '@media': {
        '(prefers-reduced-motion: reduce)': { transition: 'none' },
      },
    },
  },
});

/**
 * Animated panel: height transitions from 0 → --collapsible-panel-height
 * using base-ui's CSS variable. data-starting-style / data-ending-style
 * mark the from/to keyframes so enter and exit animations are symmetric.
 */
export const panel = style({
  height: 'var(--collapsible-panel-height)',
  overflow: 'hidden',
  transition: 'height 200ms ease, opacity 150ms ease',
  selectors: {
    '&[data-starting-style]': { height: 0, opacity: 0 },
    '&[data-ending-style]': { height: 0, opacity: 0 },
  },
});
