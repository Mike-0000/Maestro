import { style } from '@vanilla-extract/css';
import { recipesLayer } from '@styles/layers.css';
// Emit the input recipe first so this override follows it in the recipes layer
// (equal specificity: the later rule wins).
import '@styles/recipes/input.css';

/**
 * Overrides applied on top of inputVariants to turn a fixed-height input into
 * an auto-growing textarea.
 *
 * Box group (height, min-height, block padding, field sizing), so it lives in
 * `@layer recipes` with the input recipe's own box styles: it beats them by
 * source order, and app Tailwind utilities (`min-h-56`, `h-full`, `py-2.5`,
 * `field-sizing-fixed`) beat it.
 */
export const textareaOverride = style({
  '@layer': {
    [recipesLayer]: {
      height: 'auto',
      // field-sizing: content makes the textarea grow with its text content (modern browsers).
      // @ts-ignore — non-standard property, not yet in TypeScript's CSSType
      fieldSizing: 'content',
      minHeight: '4rem',
      paddingTop: '0.5rem',
      paddingBottom: '0.5rem',
    },
  },
});
