import { globalStyle, style } from '@vanilla-extract/css';
import { recipesLayer } from '@styles/layers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/**
 * Input-appearance layout for TriggerButton.
 * Provides the structural (non-visual) properties when appearance="input".
 * fieldShellBase (imported at runtime in trigger-button.tsx) handles border/bg/focus.
 *
 * The layout group (display, width, height, padding, gap, font size) lives in
 * `@layer recipes`, so a caller sizes the trigger with utilities (`w-32`,
 * `max-w-48`) instead of a wrapper box. The placeholder colour stays
 * unlayered: colour belongs to the unlayered field shell, which it overrides.
 */
export const triggerInputLayoutBase = style({
  '@layer': {
    [recipesLayer]: {
      display: 'flex',
      width: '100%',
      height: '2rem',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.375rem',
      paddingLeft: '0.625rem',
      paddingRight: '0.375rem',
      fontSize: tokenVars.textSm,
    },
  },
  selectors: {
    '&[data-placeholder]': { color: vars.foregroundPassive },
  },
});

export const triggerInputLayoutSm = style({
  '@layer': {
    [recipesLayer]: {
      height: '1.5rem',
      paddingLeft: '0.5rem',
      fontSize: tokenVars.textXs,
    },
  },
});

/** Trailing chevron icon inside TriggerButton. */
export const triggerButtonChevron = style({
  pointerEvents: 'none',
  flexShrink: 0,
  color: vars.foregroundPassive,
});

/** Extra styles applied on top of controlVariants for TriggerButton. */
export const triggerButtonExtra = style({
  width: 'fit-content',
  justifyContent: 'space-between',
  gap: '0.375rem',
  selectors: {
    '&[data-placeholder]': { color: vars.foregroundPassive },
  },
});
globalStyle(`${triggerButtonExtra} > [data-slot="trigger-value"]`, {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
});
