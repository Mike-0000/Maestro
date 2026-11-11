/**
 * fieldShellBase — shared visual shell for all field-shaped controls.
 *
 * Owns: border, background, focus ring, hover border, invalid state, disabled.
 * Does NOT own: width, height, padding, font-size — those belong to each consumer.
 *
 * Look (design brief 2.8): rounded-md; in dark a fill one step off the surface it
 * sits on (`surfaceInput` follows the surface cascade) with a hairline edge; in
 * light a near-white field with the findable control edge (`border-1`); placeholder in the passive
 * tone. Keyboard focus draws the accent ring: the edge turns accent and a 1px
 * accent ring doubles it, so focus never depends on the fill. Invalid fields
 * turn their edge destructive; the message under the field carries the words.
 *
 * Composed by:
 *   - inputVariants (Input, Textarea, InputGroup)
 *   - TriggerButton appearance="input" (Select, ComboboxPopover form fields)
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/** Light themes, where inputs at rest need an edge you can find. */
export const LIGHT_THEME_SCOPE = ':where(.emlight, .emsolarized-light)';

export const fieldFocusRing = {
  borderColor: vars.focusRing,
  boxShadow: `0 0 0 1px ${vars.focusRing}`,
} as const;

export const fieldShellBase = style({
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceInput,
  color: vars.foreground,
  transition: 'color 150ms, box-shadow 150ms, border-color 150ms, background-color 150ms',
  outline: 'none',
  selectors: {
    // Light: a near-white field with a findable edge (a tinted fill reads heavy).
    [`${LIGHT_THEME_SCOPE} &`]: {
      borderColor: vars.border1,
      backgroundColor: vars.surfaceElevated,
    },
    '&::placeholder': { color: vars.foregroundPassive },
    '&:hover': { borderColor: vars.border1 },
    [`${LIGHT_THEME_SCOPE} &:hover`]: { borderColor: vars.border2 },
    '&:focus-visible': fieldFocusRing,
    [`${LIGHT_THEME_SCOPE} &:focus-visible`]: fieldFocusRing,
    '&:disabled, &[data-disabled]': {
      pointerEvents: 'none',
      cursor: 'not-allowed',
      opacity: 0.5,
    },
    '&[aria-invalid="true"]': {
      borderColor: vars.borderDestructive,
      boxShadow: 'none',
    },
    [`${LIGHT_THEME_SCOPE} &[aria-invalid="true"]`]: { borderColor: vars.borderDestructive },
    '&[aria-invalid="true"]:focus-visible': {
      borderColor: vars.borderDestructive,
      boxShadow: `0 0 0 1px ${vars.borderDestructive}`,
    },
  },
});
