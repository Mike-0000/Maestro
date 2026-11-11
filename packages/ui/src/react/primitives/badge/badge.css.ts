import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { svgContainer, svgSmSize } from '@styles/effects/svg-helpers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A quiet chip (design brief 2.13.11): caption-role text on one neutral
// surface step (soft) or inside one neutral hairline (outline), fully rounded.
// State is words plus a glyph, not colour (brief 2.6): only an error and a
// warning tint the text; success reads in full strength, info muted.
export const badge = recipe({
  base: [
    svgContainer,
    svgSmSize,
    {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 'fit-content',
      height: '1.125rem',
      flexShrink: 0,
      gap: '0.25rem',
      overflow: 'hidden',
      padding: '0 0.4375rem',
      borderRadius: tokenVars.radiusFull,
      border: '1px solid transparent',
      fontSize: tokenVars.textTiny,
      lineHeight: 1,
      fontWeight: 500,
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      transition: 'color 150ms, background-color 150ms, border-color 150ms',
      selectors: {
        '&:focus-visible': {
          outline: `2px solid ${vars.focusRing}`,
          outlineOffset: '1px',
        },
      },
    },
  ],

  variants: {
    variant: {
      soft: {
        backgroundColor: `color-mix(in srgb, ${vars.foreground} 7%, transparent)`,
      },
      outline: {
        backgroundColor: 'transparent',
        borderColor: vars.border,
      },
    },
    tone: {
      neutral: { color: vars.foregroundMuted },
      success: { color: vars.foreground },
      warning: { color: vars.foregroundWarning },
      error: { color: vars.foregroundError },
      info: { color: vars.foregroundMuted },
    },
  },

  compoundVariants: [
    // Neutral outline reads as a quiet chip: full foreground text, hairline border.
    {
      variants: { variant: 'outline', tone: 'neutral' },
      style: { color: vars.foreground },
    },
  ],

  defaultVariants: {
    variant: 'soft',
    tone: 'neutral',
  },
});

export type BadgeVariants = NonNullable<RecipeVariants<typeof badge>>;
