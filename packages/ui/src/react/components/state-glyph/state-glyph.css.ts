import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
// Side-effect import so the @layer order declaration is emitted before these
// rules; otherwise `recipes` gets registered first and loses to app layers.
import '@styles/layers.css';

// The one set of state marks (design brief 2.6), the same the workbench sidebar
// and the conductor screen draw: a filled near-white dot when the developer is
// needed, a softly pulsing accent dot while working, a bright ring for a finish
// not looked at yet, a passive ring once seen (dimmer when idle), a filled
// error dot. Only the working dot moves, and not under reduced motion.

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.35 },
});

export const slot = style({
  '@layer': {
    recipes: {
      display: 'inline-flex',
      width: '1rem',
      height: '1rem',
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
    },
  },
});

export const slotSize = styleVariants({
  sm: { '@layer': { recipes: { width: '0.75rem', height: '0.75rem' } } },
  md: {},
});

const dot = {
  display: 'block',
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '9999px',
  flexShrink: 0,
} as const;

const ring = {
  ...dot,
  boxSizing: 'border-box',
  border: '1.5px solid',
} as const;

export const mark = styleVariants({
  'needs-you': { '@layer': { recipes: { ...dot, backgroundColor: vars.foreground } } },
  working: {
    '@layer': {
      recipes: {
        ...dot,
        width: '0.375rem',
        height: '0.375rem',
        backgroundColor: vars.accent,
        animation: `${pulse} 2s cubic-bezier(0.4, 0, 0.6, 1) infinite`,
        '@media': {
          '(prefers-reduced-motion: reduce)': { animation: 'none' },
        },
      },
    },
  },
  unread: { '@layer': { recipes: { ...ring, borderColor: vars.foreground } } },
  done: { '@layer': { recipes: { ...ring, borderColor: vars.foregroundPassive } } },
  idle: { '@layer': { recipes: { ...ring, borderColor: vars.foregroundPassive, opacity: 0.6 } } },
  error: { '@layer': { recipes: { ...dot, backgroundColor: vars.foregroundError } } },
  'setting-up': { '@layer': { recipes: { color: vars.foregroundPassive, fontSize: '0.75rem' } } },
});
