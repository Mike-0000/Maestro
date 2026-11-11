import '@styles/layers.css';
import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const root = style({
  '@layer': {
    recipes: {
      display: 'flex',
      width: '100%',
      minWidth: 0,
      alignItems: 'center',
      gap: '0.75rem',
    },
  },
});

export const icon = style({
  '@layer': {
    recipes: {
      display: 'flex',
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
  },
});

export const title = style({
  '@layer': {
    recipes: {
      display: 'flex',
      minWidth: 0,
      flex: '1 1 auto',
      alignItems: 'center',
      overflow: 'hidden',
      // Page-title role for the identity line (design brief 2.4); callers'
      // own heading classes still win (recipes layer).
      fontSize: tokenVars.textXl,
      lineHeight: tokenVars.textXlLineHeight,
      fontWeight: 500,
      letterSpacing: '-0.01em',
      color: vars.foreground,
    },
  },
});

export const actions = style({
  '@layer': {
    recipes: {
      display: 'flex',
      minWidth: 0,
      flexShrink: 0,
      alignItems: 'center',
      gap: '0.5rem',
      marginLeft: 'auto',
    },
  },
});
