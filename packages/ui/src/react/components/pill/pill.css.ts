import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

const dotPulse = keyframes({
  '0%, 100%': {
    opacity: 1,
  },
  '50%': {
    opacity: 0.4,
  },
});

export const root = style({
  '@layer': {
    recipes: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.375rem',
      padding: '0.125rem 0.625rem',
      borderRadius: '9999px',
      fontSize: 'var(--em-text-xs)',
      fontWeight: 500,
      lineHeight: 'var(--em-text-xs--line-height)',
      whiteSpace: 'nowrap',
    },
  },
});

export const label = style({
  '@layer': {
    recipes: {
      color: 'currentColor',
    },
  },
});

export const dot = style({
  '@layer': {
    recipes: {
      width: '0.375rem',
      height: '0.375rem',
      borderRadius: '50%',
      backgroundColor: 'currentColor',
      flexShrink: 0,
    },
  },
});

export const pulsingDot = style({
  '@layer': {
    recipes: {
      animationName: dotPulse,
      animationDuration: '1.5s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media': {
        '(prefers-reduced-motion: reduce)': {
          animationName: 'none',
        },
      },
    },
  },
});

// Quiet pills (design brief 2.13.11): one neutral surface step for every tone;
// only an error and a warning colour the words and the dot (brief 2.6).
const quietFill = `color-mix(in srgb, ${vars.foreground} 7%, transparent)`;

export const variant = {
  neutral: style({
    '@layer': {
      recipes: {
        color: vars.foregroundMuted,
        backgroundColor: quietFill,
      },
    },
  }),
  success: style({
    '@layer': {
      recipes: {
        color: vars.foreground,
        backgroundColor: quietFill,
      },
    },
  }),
  warning: style({
    '@layer': {
      recipes: {
        color: vars.foregroundWarning,
        backgroundColor: quietFill,
      },
    },
  }),
  error: style({
    '@layer': {
      recipes: {
        color: vars.foregroundError,
        backgroundColor: quietFill,
      },
    },
  }),
  info: style({
    '@layer': {
      recipes: {
        color: vars.foregroundMuted,
        backgroundColor: quietFill,
      },
    },
  }),
};
