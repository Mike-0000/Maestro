import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

// The caption-role line (the conductor's vitals footer shape): 11px passive,
// tabular figures; the leading facts on the left joined with " · ", the
// trailing facts pushed right. Under 34rem of width the trailing facts step
// aside so the leading state stays readable.

export const container = style({
  '@layer': { recipes: { containerType: 'inline-size', minWidth: 0 } },
});

export const root = style({
  '@layer': {
    recipes: {
      display: 'flex',
      minWidth: 0,
      minHeight: '1.5rem',
      alignItems: 'center',
      gap: '1rem',
      fontSize: tokenVars.textTiny,
      lineHeight: tokenVars.textTinyLineHeight,
      fontVariantNumeric: 'tabular-nums',
      color: vars.foregroundPassive,
    },
  },
});

export const start = style({
  '@layer': {
    recipes: {
      display: 'flex',
      minWidth: 0,
      flexShrink: 1,
      alignItems: 'center',
      gap: '0.375rem',
    },
  },
});

export const end = style({
  '@layer': {
    recipes: {
      display: 'flex',
      minWidth: 0,
      flexShrink: 2,
      alignItems: 'center',
      gap: '0.75rem',
      marginLeft: 'auto',
      '@container': {
        '(max-width: 34rem)': { display: 'none' },
      },
    },
  },
});

export const endKeep = style({
  '@layer': {
    recipes: {
      '@container': {
        '(max-width: 34rem)': { display: 'flex' },
      },
    },
  },
});

export const facts = style({
  '@layer': {
    recipes: {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
  },
});

/** A fact that should read a step stronger (the state while it needs you). */
export const strong = style({
  '@layer': { recipes: { color: vars.foregroundMuted } },
});
