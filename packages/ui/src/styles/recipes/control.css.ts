/**
 * controlVariants — the shared recipe for every button-shaped control (Button,
 * SplitButton, TriggerButton, Toggle, Tabs, Collapsible trigger).
 *
 * Call controlVariants({ variant, tone, size, icon, kbd }) to get a class-name
 * string. RecipeVariants<typeof controlVariants> is the props type.
 *
 * Variants (design brief 2.7: one calm primary per view, everything else quiet):
 *   primary   — the one move on a view or dialog (accent solid, weight 500)
 *   secondary — a quiet filled control, no border; rare in feature code
 *   ghost     — transparent until hover; the default and the icon-button face
 *   text      — an underlined muted text action (no box at all)
 *
 * Every style here lives in `@layer recipes`, so the app's Tailwind utilities
 * (layer `utilities`) and `sx()` sprinkles override a control without `!`.
 * Kit components that compose this recipe and add their own (unlayered) class
 * still win over it, as before.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import type { StyleRule } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { recipesLayer } from '@styles/layers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/** Wrap a style rule in the recipes layer. */
const layered = (rule: StyleRule): StyleRule => ({ '@layer': { [recipesLayer]: rule } });

/**
 * Keyboard focus: a 2px accent outline just outside the control. An outline
 * follows the border radius, does not shift layout and is not hidden by the
 * control's own fill or border (a flush box-shadow ring vanishes against the
 * primary button's accent rim).
 */
const focusVisible = {
  outline: `2px solid ${vars.focusRing}`,
  outlineOffset: '1px',
} as const;

/** Selectors that mean "this control is on / open / chosen". */
const ON_STATES = [
  '&[aria-expanded="true"]',
  '&[aria-pressed="true"]',
  '&[aria-selected="true"]',
  '&[data-pressed]',
  '&[data-selected]',
  '&[data-popup-open]',
  '&[data-active="true"]',
] as const;

function onStates(rule: StyleRule): Record<string, StyleRule> {
  return Object.fromEntries(ON_STATES.map((selector) => [selector, rule]));
}

const quietFill = `color-mix(in srgb, ${vars.foreground} 6%, transparent)`;
const quietFillHover = `color-mix(in srgb, ${vars.foreground} 9%, transparent)`;
const quietFillOn = `color-mix(in srgb, ${vars.foreground} 12%, transparent)`;
const primaryPressed = `color-mix(in srgb, ${vars.primaryButtonBackgroundHover} 88%, ${vars.foreground})`;

// Pre-create base style so we can attach globalStyle child selectors
const controlBase = style(
  layered({
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokenVars.radiusMd,
    border: '1px solid transparent',
    backgroundClip: 'padding-box',
    fontFamily: 'inherit',
    fontSize: tokenVars.textSm,
    lineHeight: tokenVars.textSmLineHeight,
    fontWeight: 400,
    whiteSpace: 'nowrap',
    cursor: 'default',
    transitionProperty: 'background-color, color, border-color, text-decoration-color, opacity',
    transitionDuration: '150ms',
    outline: 'none',
    userSelect: 'none',
    selectors: {
      '&:focus-visible': focusVisible,
      '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
      '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
    },
  })
);
globalStyle(`${controlBase} svg`, {
  '@layer': { [recipesLayer]: { pointerEvents: 'none', flexShrink: 0 } },
});
globalStyle(`${controlBase} svg:not([class*='size-'])`, {
  '@layer': { [recipesLayer]: { width: '1rem', height: '1rem' } },
});

// Pre-create xs size style for its svg override
const xsSizeBase = style(
  layered({
    height: '1.5rem',
    gap: '0.25rem',
    paddingLeft: '0.5rem',
    paddingRight: '0.5rem',
    fontSize: tokenVars.textXs,
    lineHeight: tokenVars.textXsLineHeight,
    borderRadius: tokenVars.radiusSm,
  })
);
globalStyle(`${xsSizeBase} svg:not([class*='size-'])`, {
  '@layer': { [recipesLayer]: { width: '0.875rem', height: '0.875rem' } },
});

export const controlVariants = recipe({
  base: controlBase,

  variants: {
    variant: {
      ghost: layered({
        // Transparent at rest: blend into the surface behind us, only tinting
        // on interaction via the surface cascade vars.
        backgroundColor: 'transparent',
        color: vars.foregroundMuted,
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
          ...onStates({ backgroundColor: vars.surfaceSelected, color: vars.foreground }),
        },
      }),
      primary: layered({
        backgroundColor: vars.primaryButtonBackground,
        color: vars.primaryButtonForeground,
        borderColor: vars.primaryButtonBorder,
        fontWeight: 500,
        selectors: {
          '&:hover': { backgroundColor: vars.primaryButtonBackgroundHover },
          '&:active': { backgroundColor: primaryPressed },
          ...onStates({ backgroundColor: primaryPressed }),
          '&[aria-expanded="true"]': { backgroundColor: vars.primaryButtonBackgroundHover },
          '&[data-popup-open]': { backgroundColor: vars.primaryButtonBackgroundHover },
        },
      }),
      secondary: layered({
        backgroundColor: quietFill,
        color: vars.foreground,
        selectors: {
          '&:hover': { backgroundColor: quietFillHover },
          '&:active': { backgroundColor: quietFillOn },
          ...onStates({ backgroundColor: quietFillOn }),
        },
      }),
      text: layered({
        backgroundColor: 'transparent',
        color: vars.foregroundMuted,
        textDecorationLine: 'underline',
        textDecorationThickness: '1px',
        textUnderlineOffset: '4px',
        textDecorationColor: `color-mix(in srgb, ${vars.foregroundPassive} 60%, transparent)`,
        selectors: {
          '&:hover': { color: vars.foreground, textDecorationColor: vars.foregroundMuted },
          '&:focus-visible': { color: vars.foreground },
          ...onStates({ color: vars.foreground, textDecorationColor: vars.foregroundMuted }),
          '&:disabled, &[data-disabled]': { textDecorationLine: 'none' },
        },
      }),
    },

    tone: {
      neutral: {},
      destructive: {},
      warning: {},
      info: {},
      success: {},
    },

    // Four-step control scale: xs 24px / sm 28px / base 32px / lg 40px.
    size: {
      base: layered({
        height: '2rem',
        gap: '0.375rem',
        paddingLeft: '0.75rem',
        paddingRight: '0.75rem',
      }),
      xs: xsSizeBase,
      sm: layered({
        height: '1.75rem',
        gap: '0.375rem',
        paddingLeft: '0.625rem',
        paddingRight: '0.625rem',
      }),
      lg: layered({
        height: '2.5rem',
        gap: '0.5rem',
        paddingLeft: '1rem',
        paddingRight: '1rem',
      }),
      // An inline link: no box, link colour, underline that firms up on hover.
      link: layered({
        height: 'auto',
        gap: '0.25rem',
        border: 'none',
        borderRadius: tokenVars.radiusXs,
        backgroundColor: 'transparent',
        padding: 0,
        color: vars.link,
        textDecorationLine: 'underline',
        textDecorationThickness: '1px',
        textUnderlineOffset: '3px',
        textDecorationColor: `color-mix(in srgb, ${vars.link} 40%, transparent)`,
        selectors: {
          '&:hover': { textDecorationColor: vars.link },
        },
      }),
    },

    icon: {
      true: {},
      false: {},
    },
    kbd: {
      true: {},
      false: {},
    },
  },

  compoundVariants: [
    // text: no box. Compound variants emit after the size variants, so these
    // win over the size heights and paddings at equal specificity.
    {
      variants: { variant: 'text' },
      style: layered({
        height: 'auto',
        paddingLeft: 0,
        paddingRight: 0,
        border: 'none',
        borderRadius: tokenVars.radiusSm,
        backgroundColor: 'transparent',
        selectors: {
          '&:hover': { backgroundColor: 'transparent' },
          ...onStates({ backgroundColor: 'transparent' }),
        },
      }),
    },
    { variants: { variant: 'text', size: 'xs' }, style: layered({ fontSize: tokenVars.textXs }) },
    {
      variants: { variant: 'text', tone: 'destructive' },
      style: layered({
        color: vars.foregroundDestructive,
        textDecorationColor: `color-mix(in srgb, ${vars.foregroundDestructive} 50%, transparent)`,
        selectors: {
          '&:hover': {
            color: vars.foregroundDestructive,
            textDecorationColor: vars.foregroundDestructive,
          },
        },
      }),
    },
    // ghost + link: keep transparent background across all interaction states so the ghost
    // hover colour never bleeds through.
    {
      variants: { variant: 'ghost', size: 'link' },
      style: layered({
        backgroundColor: 'transparent',
        color: vars.link,
        selectors: {
          '&:hover': { backgroundColor: 'transparent', color: vars.link },
          ...onStates({ backgroundColor: 'transparent', color: vars.link }),
        },
      }),
    },
    // ghost + destructive
    {
      variants: { variant: 'ghost', tone: 'destructive' },
      style: layered({
        color: vars.foregroundDestructive,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceDestructiveHover,
            color: vars.foregroundDestructive,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceDestructiveSelected },
        },
      }),
    },
    // ghost + warning
    {
      variants: { variant: 'ghost', tone: 'warning' },
      style: layered({
        color: vars.foregroundWarning,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceWarningHover,
            color: vars.foregroundWarning,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceWarningSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceWarningSelected },
        },
      }),
    },
    // ghost + info
    {
      variants: { variant: 'ghost', tone: 'info' },
      style: layered({
        color: vars.foregroundInfo,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceInfoHover,
            color: vars.foregroundInfo,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceInfoSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceInfoSelected },
        },
      }),
    },
    // ghost + success
    {
      variants: { variant: 'ghost', tone: 'success' },
      style: layered({
        color: vars.foregroundSuccess,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceSuccessHover,
            color: vars.foregroundSuccess,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceSuccessSelected },
        },
      }),
    },
    // primary + destructive (Button variant="destructive"): a quiet red room with
    // red ink, never a coloured rim. Used only inside its confirm dialog.
    {
      variants: { variant: 'primary', tone: 'destructive' },
      style: layered({
        backgroundColor: vars.backgroundDestructive,
        color: vars.foregroundDestructive,
        borderColor: 'transparent',
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceDestructiveHover },
          '&:active': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-active="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[aria-expanded="true"]': { backgroundColor: vars.surfaceDestructiveHover },
          '&[data-popup-open]': { backgroundColor: vars.surfaceDestructiveHover },
        },
      }),
    },
    // icon + base → 2rem square
    {
      variants: { icon: true, size: 'base' },
      style: layered({ width: '2rem', height: '2rem', paddingLeft: 0, paddingRight: 0 }),
    },
    // icon + xs → 1.5rem square
    {
      variants: { icon: true, size: 'xs' },
      style: layered({ width: '1.5rem', height: '1.5rem', paddingLeft: 0, paddingRight: 0 }),
    },
    // icon + sm → 1.75rem square
    {
      variants: { icon: true, size: 'sm' },
      style: layered({ width: '1.75rem', height: '1.75rem', paddingLeft: 0, paddingRight: 0 }),
    },
    // icon + lg → 2.5rem square
    {
      variants: { icon: true, size: 'lg' },
      style: layered({ width: '2.5rem', height: '2.5rem', paddingLeft: 0, paddingRight: 0 }),
    },
    // Icon buttons read as quiet glyphs: passive at rest, full strength on hover.
    {
      variants: { icon: true, variant: 'ghost', tone: 'neutral' },
      style: layered({ color: vars.foregroundPassive }),
    },
    // kbd + base → align the trailing shortcut and keep the text-to-kbd gap
    // equal to the right padding so the Kbd sits in a balanced right-side slot.
    {
      variants: { kbd: true, size: 'base' },
      style: layered({ gap: tokenVars.space2, paddingRight: tokenVars.space1_5 }),
    },
    {
      variants: { kbd: true, size: 'lg' },
      style: layered({ gap: tokenVars.space2, paddingRight: tokenVars.space2 }),
    },
    // kbd + xs / sm → smaller right-side slot for the smaller buttons.
    {
      variants: { kbd: true, size: 'xs' },
      style: layered({ gap: '6px', paddingRight: '3px' }),
    },
    {
      variants: { kbd: true, size: 'sm' },
      style: layered({ gap: '6px', paddingRight: tokenVars.space1 }),
    },
  ],

  defaultVariants: {
    variant: 'ghost',
    tone: 'neutral',
    size: 'base',
    icon: false,
    kbd: false,
  },
});

export type ControlVariantProps = NonNullable<RecipeVariants<typeof controlVariants>>;
