import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

/** TabsList container strip. */
export const tabsList = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  selectors: {
    '&[data-orientation="vertical"]': {
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: '1px',
    },
  },
});

/** Underline tabs sit further apart: they are words, not buttons. */
export const tabsListUnderline = style({
  gap: '0.25rem',
});

/**
 * Tabs use the shared ghost-control sizing and focus treatment, but remain
 * visually flat. Selection is communicated through foreground emphasis rather
 * than button-like surface fills.
 */
export const tab = style({
  backgroundColor: 'transparent',
});

globalStyle(`${tab}:hover`, { backgroundColor: 'transparent' });
globalStyle(`${tab}[data-selected]`, { backgroundColor: 'transparent' });
globalStyle(`${tab}[aria-selected='true']`, { backgroundColor: 'transparent' });
globalStyle(`${tab}[data-active='true']`, { backgroundColor: 'transparent' });

/**
 * Underline variant (the conductor status strip's text tabs): muted words, the
 * one on screen in full strength with a 1px underline in its own colour.
 */
export const tabUnderline = style({
  position: 'relative',
  color: vars.foregroundMuted,
  selectors: {
    '&::after': {
      content: '""',
      pointerEvents: 'none',
      position: 'absolute',
      left: '0.5rem',
      right: '0.5rem',
      bottom: 0,
      height: '1px',
      borderRadius: '9999px',
      backgroundColor: 'currentColor',
      opacity: 0,
      transition: 'opacity 150ms',
    },
    '&:hover': { color: vars.foreground },
    '&[aria-selected="true"], &[data-selected]': { color: vars.foreground },
    '&[aria-selected="true"]::after, &[data-selected]::after': { opacity: 1 },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      selectors: { '&::after': { transition: 'none' } },
    },
  },
});

/** TabsPanel — only needs outline:none (focus). */
export const tabsPanel = style({
  outline: 'none',
});
