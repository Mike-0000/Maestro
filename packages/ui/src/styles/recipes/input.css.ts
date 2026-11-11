/**
 * inputVariants — Vanilla Extract recipe replacing the CVA inputVariants.
 * Used by Input, Textarea, and InputGroup control slots.
 *
 * Visual shell (border, background, focus ring, hover, invalid) is composed
 * from fieldShellBase so Select/Combobox triggers can share the same look.
 */

import type { StyleRule } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { fieldShellBase } from './field-shell.css';
import { recipesLayer } from '@styles/layers.css';
import { tokenVars } from '@theme/tokens.css';

/** Wrap a style rule in the recipes layer. */
const layered = (rule: StyleRule): StyleRule => ({ '@layer': { [recipesLayer]: rule } });

/*
 * Two property-ownership groups, kept apart so no property is set both inside
 * and outside a layer on the same element:
 *
 *   - box: width, height, padding, font size, line height, colour scheme. This
 *     group lives in `@layer recipes`, so app Tailwind utilities (`h-7`, `px-0`,
 *     `text-xs`, `w-28`) and sx() sprinkles size an input without inline styles.
 *   - shell: border, fill, radius, colour, focus ring (fieldShellBase and the
 *     `bare` variant). Still unlayered: TriggerButton, DirectoryField and the
 *     combobox field compose the same shell and override it at equal footing.
 *
 * Kit styles that override the box group (InputGroup's addon padding, the
 * textarea override) are unlayered or emitted later in the same layer, so they
 * still win.
 */
export const inputVariants = recipe({
  base: [
    fieldShellBase,
    layered({
      width: '100%',
      minWidth: 0,
      fontSize: tokenVars.textSm,
      lineHeight: tokenVars.textSmLineHeight,
      // Native pickers, autofill and scrollbars follow the active theme.
      colorScheme: 'light',
      selectors: {
        ':where(.emdark, .emsolarized-dark) &': { colorScheme: 'dark' },
      },
    }),
  ],

  variants: {
    size: {
      base: layered({
        height: '2rem',
        paddingLeft: '0.625rem',
        paddingRight: '0.625rem',
        paddingTop: '0.25rem',
        paddingBottom: '0.25rem',
      }),
      sm: layered({
        height: '1.5rem',
        paddingLeft: '0.5rem',
        paddingRight: '0.5rem',
        paddingTop: '0.125rem',
        paddingBottom: '0.125rem',
        fontSize: tokenVars.textXs,
      }),
    },

    /**
     * bare — strips the standalone border, background, and focus ring so the input
     * can live inside a group container that provides those affordances.
     * Removes the need for !important overrides on the wrapping control slot.
     * Shell group: unlayered, like fieldShellBase, which it overrides.
     */
    bare: {
      true: {
        border: 0,
        backgroundColor: 'transparent',
        boxShadow: 'none',
        selectors: {
          '&:hover': { borderColor: 'inherit' },
          '&:focus-visible': { borderColor: 'inherit', boxShadow: 'none' },
          '&[aria-invalid="true"]': { borderColor: 'inherit', boxShadow: 'none' },
        },
      },
    },
  },

  defaultVariants: {
    size: 'base',
    bare: false,
  },
});

export type InputVariantProps = NonNullable<RecipeVariants<typeof inputVariants>>;
