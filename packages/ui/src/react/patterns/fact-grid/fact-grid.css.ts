import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

// The label / value grid from the conductor's report ("You asked / Where it
// is / Your move"): small muted labels in a fixed column, values beside them
// aligned on the first baseline. Under 34rem of width the pairs stack.

export const container = style({
  '@layer': { recipes: { containerType: 'inline-size', minWidth: 0 } },
});

export const grid = style({
  '@layer': {
    recipes: {
      display: 'grid',
      gridTemplateColumns: 'var(--fact-grid-label-width, 6rem) minmax(0, 1fr)',
      alignItems: 'baseline',
      columnGap: '1rem',
      rowGap: '0.625rem',
      margin: 0,
      '@container': {
        '(max-width: 34rem)': {
          gridTemplateColumns: 'minmax(0, 1fr)',
          rowGap: '0.125rem',
        },
      },
    },
  },
});

/** Key / value label (`dt`): 12px muted. */
export const label = style({
  '@layer': {
    recipes: {
      margin: 0,
      fontSize: tokenVars.textXs,
      lineHeight: tokenVars.textXsLineHeight,
      color: vars.foregroundMuted,
    },
  },
});

export const value = style({
  '@layer': {
    recipes: {
      margin: 0,
      minWidth: 0,
      fontSize: tokenVars.textSm,
      lineHeight: tokenVars.textSmLineHeight,
      color: vars.foregroundBody,
      overflowWrap: 'anywhere',
      '@container': {
        '(max-width: 34rem)': {
          selectors: { '&:not(:last-child)': { marginBottom: '0.75rem' } },
        },
      },
    },
  },
});

/** Reading context (threads, reports): values at the 14px reading size. */
export const valueReading = style({
  '@layer': {
    recipes: {
      fontSize: tokenVars.textBase,
      lineHeight: tokenVars.textBaseLineHeight,
    },
  },
});

/** The value that matters most ("Your move"): semibold, full strength. */
export const valueEmphasis = style({
  '@layer': {
    recipes: {
      fontWeight: 600,
      color: vars.foreground,
    },
  },
});
