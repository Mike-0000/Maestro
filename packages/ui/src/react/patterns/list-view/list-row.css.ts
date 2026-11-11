import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const row = recipe({
  base: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    borderBottom: `1px solid ${vars.border}`,
    transition: 'background-color 100ms',
  },
  variants: {
    interactive: {
      true: {
        cursor: 'pointer',
        outline: 'none',
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceHover },
          '&:focus-visible': { boxShadow: `inset 0 0 0 1px ${vars.focusRing}` },
        },
      },
    },
    selected: {
      true: {
        backgroundColor: vars.surfaceSelected,
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceSelected },
        },
      },
    },
    isLast: {
      true: { borderBottom: 'none' },
    },
    divider: {
      default: {},
      subtle: { borderBottomColor: vars.borderSubtle },
      /** No rule: rows separate by rhythm and the hover fill (design brief 2.2). */
      none: { borderBottom: 'none' },
    },
    /** Rounded rows, for flat lists that sit straight on the page. */
    rounded: {
      true: { borderRadius: tokenVars.radiusMd },
    },
  },
  defaultVariants: {
    interactive: false,
    selected: false,
    isLast: false,
    divider: 'default',
    rounded: false,
  },
});

export type RowVariants = NonNullable<RecipeVariants<typeof row>>;

/** Inner content padding for a standard Row. */
export const rowInner = style({
  display: 'flex',
  position: 'relative',
  alignItems: 'flex-start',
  gap: '0.75rem',
  padding: '0.75rem',
});

/**
 * SectionHeader — label + optional count, used by the Agents view
 * "Recommended (4)" / "All agents (12)" pattern.
 */
export const sectionHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  paddingLeft: '1rem',
  paddingRight: '1rem',
  paddingTop: '0.75rem',
  paddingBottom: '0.375rem',
});

// Group-label role (design brief 2.4): 11px passive, sentence case.
export const sectionHeaderLabel = style({
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  fontWeight: 400,
  color: vars.foregroundPassive,
});

export const sectionHeaderCount = style({
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  fontVariantNumeric: 'tabular-nums',
  color: vars.foregroundPassive,
});
