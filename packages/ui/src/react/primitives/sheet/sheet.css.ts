import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import {
  kfFadeIn,
  kfFadeOut,
  kfSlideInFromRight,
  kfSlideInFromLeft,
  kfSlideInFromTop,
  kfSlideInFromBottom,
  kfSlideOutToRight,
  kfSlideOutToLeft,
  kfSlideOutToTop,
  kfSlideOutToBottom,
} from '@styles/effects/animations.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

const noDragRegion = { WebkitAppRegion: 'no-drag' } as Record<string, string>;

// Sheets share the dialog anatomy (design brief 2.9): the elevated surface, one
// hairline, the dialog-title role, 24px padding, no rules; 34rem wide from the
// right, sliding in over 200ms.

const reducedMotion = {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      selectors: { '&[data-open], &[data-closed]': { animation: 'none' } },
    },
  },
} as const;

export const backdrop = style({
  ...noDragRegion,
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  backgroundColor: vars.backdrop,
  selectors: {
    '&[data-open]': { animation: `${kfFadeIn} 150ms both` },
    '&[data-closed]': { animation: `${kfFadeOut} 150ms both` },
  },
  ...reducedMotion,
});

export const sheetContent = recipe({
  base: {
    ...noDragRegion,
    position: 'fixed',
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontSize: tokenVars.textSm,
    lineHeight: tokenVars.textSmLineHeight,
    color: vars.foreground,
    backgroundColor: vars.surface,
    boxShadow: `${vars.shadowOverlay}, 0 0 0 1px ${vars.borderSubtle}`,
    outline: 'none',
    ...reducedMotion,
  },
  variants: {
    side: {
      right: {
        top: 0,
        bottom: 0,
        right: 0,
        height: '100%',
        width: '75%',
        '@media': {
          '(min-width: 640px)': { maxWidth: '34rem' },
        },
        selectors: {
          '&[data-open]': { animation: `${kfSlideInFromRight} 200ms both` },
          '&[data-closed]': { animation: `${kfSlideOutToRight} 200ms both` },
        },
      },
      left: {
        top: 0,
        bottom: 0,
        left: 0,
        height: '100%',
        width: '75%',
        '@media': {
          '(min-width: 640px)': { maxWidth: '28rem' },
        },
        selectors: {
          '&[data-open]': { animation: `${kfSlideInFromLeft} 200ms both` },
          '&[data-closed]': { animation: `${kfSlideOutToLeft} 200ms both` },
        },
      },
      top: {
        top: 0,
        left: 0,
        right: 0,
        width: '100%',
        maxHeight: '75%',
        selectors: {
          '&[data-open]': { animation: `${kfSlideInFromTop} 200ms both` },
          '&[data-closed]': { animation: `${kfSlideOutToTop} 200ms both` },
        },
      },
      bottom: {
        bottom: 0,
        left: 0,
        right: 0,
        width: '100%',
        maxHeight: '75%',
        selectors: {
          '&[data-open]': { animation: `${kfSlideInFromBottom} 200ms both` },
          '&[data-closed]': { animation: `${kfSlideOutToBottom} 200ms both` },
        },
      },
    },
  },
  defaultVariants: { side: 'right' },
});

export const sheetHeader = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1.5rem 1.5rem 0',
});

export const sheetHeaderInner = style({
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: '0.375rem',
});

/** Dialog-title role: 16px semibold. */
export const sheetTitle = style({
  margin: 0,
  fontSize: tokenVars.textLg,
  lineHeight: tokenVars.textLgLineHeight,
  fontWeight: 600,
  letterSpacing: '-0.005em',
  color: vars.foreground,
});

export const sheetFooter = style({
  display: 'flex',
  flexShrink: 0,
  flexDirection: 'column-reverse',
  gap: '0.5rem',
  padding: '1rem 1.5rem 1.5rem',
  '@media': {
    '(min-width: 640px)': {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
  },
});

export const sheetBody = style({
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  gap: '1.25rem',
  padding: '1.25rem 1.5rem 1.5rem',
  outline: 'none',
  selectors: {
    '&:focus-visible': { outline: 'none' },
  },
});

export const closeButtonOverride = style({
  marginTop: '-0.25rem',
  marginRight: '-0.5rem',
  flexShrink: 0,
  color: vars.foregroundPassive,
  selectors: {
    '&:hover': { color: vars.foreground },
  },
});
