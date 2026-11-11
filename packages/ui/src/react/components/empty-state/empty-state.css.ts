import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

// One pattern for empty, loading and error (design brief 2.12, after the
// conductor's empty screen): centred, a quiet title, one sentence, one action.
//   page  — a whole view or pane: 26px title (21px in a narrow pane), 13px
//           sentence, action 24px below.
//   panel — inside a list, side panel or card: 13px medium title, 12px
//           sentence, action 12px below (a text action).
// Error adds the error dot before the title; technical detail sits behind a
// "Show details" disclosure in mono. Loading shows a passive spinner and one
// muted line, after a short delay so fast loads never flash.

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const root = style({
  '@layer': {
    recipes: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      minHeight: 0,
      width: '100%',
      padding: '2rem',
      backgroundColor: vars.background,
      containerType: 'inline-size',
      animation: `${fadeIn} 300ms ease-out both`,
      '@media': {
        '(prefers-reduced-motion: reduce)': { animation: 'none' },
      },
    },
  },
});

export const bare = style({
  '@layer': {
    recipes: {
      backgroundColor: 'transparent',
    },
  },
});

export const content = style({
  '@layer': {
    recipes: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      maxWidth: '24rem',
    },
  },
});

export const contentPage = style({
  '@layer': {
    recipes: {
      maxWidth: '32rem',
    },
  },
});

export const titleRow = style({
  '@layer': {
    recipes: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.5rem',
    },
  },
});

/** Panel title: 13px medium, full strength. (Kept as `label` for compatibility.) */
export const label = style({
  '@layer': {
    recipes: {
      margin: 0,
      fontFamily: tokenVars.fontSans,
      fontSize: tokenVars.textSm,
      lineHeight: tokenVars.textSmLineHeight,
      fontWeight: 500,
      color: vars.foreground,
      textWrap: 'balance',
    },
  },
});

/** Page title: the hero line, 26px medium; 21px when the pane is narrow. */
export const labelPage = style({
  '@layer': {
    recipes: {
      fontSize: tokenVars.text2xl,
      lineHeight: tokenVars.text2xlLineHeight,
      letterSpacing: '-0.015em',
      '@container': {
        '(max-width: 32rem)': {
          fontSize: tokenVars.textXl,
          lineHeight: tokenVars.textXlLineHeight,
          letterSpacing: '-0.01em',
        },
      },
    },
  },
});

export const description = style({
  '@layer': {
    recipes: {
      margin: 0,
      marginTop: '0.25rem',
      fontSize: tokenVars.textXs,
      lineHeight: tokenVars.textXsLineHeight,
      fontWeight: 400,
      color: vars.foregroundMuted,
      textWrap: 'balance',
    },
  },
});

export const descriptionPage = style({
  '@layer': {
    recipes: {
      marginTop: '0.75rem',
      maxWidth: '24rem',
      fontSize: tokenVars.textSm,
      lineHeight: 1.65,
    },
  },
});

export const action = style({
  '@layer': {
    recipes: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      columnGap: '1.25rem',
      rowGap: '0.5rem',
      marginTop: '0.75rem',
    },
  },
});

export const actionPage = style({
  '@layer': {
    recipes: {
      marginTop: '1.5rem',
    },
  },
});

/** The error dot: the same mark as StateGlyph state="error". */
export const errorDot = style({
  '@layer': {
    recipes: {
      flexShrink: 0,
      width: '0.5rem',
      height: '0.5rem',
      borderRadius: '9999px',
      backgroundColor: vars.foregroundError,
    },
  },
});

export const spinner = style({
  '@layer': {
    recipes: {
      color: vars.foregroundPassive,
      marginBottom: '0.75rem',
    },
  },
});

export const details = style({
  '@layer': {
    recipes: {
      marginTop: '1rem',
      width: '100%',
      maxWidth: '32rem',
      textAlign: 'left',
    },
  },
});

export const detailsSummary = style({
  '@layer': {
    recipes: {
      width: 'fit-content',
      marginInline: 'auto',
      cursor: 'pointer',
      listStyle: 'none',
      borderRadius: tokenVars.radiusSm,
      fontSize: tokenVars.textXs,
      color: vars.foregroundMuted,
      textDecorationLine: 'underline',
      textUnderlineOffset: '4px',
      textDecorationColor: `color-mix(in srgb, ${vars.foregroundPassive} 60%, transparent)`,
      outline: 'none',
      selectors: {
        '&::-webkit-details-marker': { display: 'none' },
        '&:hover': { color: vars.foreground },
        '&:focus-visible': { outline: `2px solid ${vars.focusRing}`, outlineOffset: '2px' },
      },
    },
  },
});

export const detailsBody = style({
  '@layer': {
    recipes: {
      marginTop: '0.75rem',
      maxHeight: '12rem',
      overflow: 'auto',
      borderRadius: tokenVars.radiusMd,
      border: `1px solid ${vars.borderSubtle}`,
      backgroundColor: vars.surfaceEmphasis,
      padding: '0.625rem 0.75rem',
      fontFamily: tokenVars.fontMono,
      fontSize: tokenVars.textXs,
      lineHeight: 1.6,
      color: vars.foregroundMuted,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
  },
});
