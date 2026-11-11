import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

type CSSExtra = { [key: string]: string };

// Page header (design brief 2.5 / 2.13.4): the page-title role with one muted
// sentence under it, 40px above and 32px below, no rule. Sticky headers paint
// the page background (the paper surface in the app) so content scrolls under them.

// ── Root ─────────────────────────────────────────────────────────────────────

export const header = style({
  display: 'flex',
  flexDirection: 'column',
  paddingBottom: '2rem',
});

export const headerSticky = style({
  position: 'sticky',
  top: 0,
  zIndex: 10,
  backgroundColor: vars.background,
  paddingTop: '2.5rem',
});

// ── Title block ──────────────────────────────────────────────────────────────

export const titleBlock = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  ...({ WebkitAppRegion: 'drag' } as CSSExtra),
});

export const title = style({
  margin: 0,
  textWrap: 'balance',
});

export const description = style({
  margin: 0,
  maxWidth: '42rem',
  textWrap: 'pretty',
});

// ── Actions slot ─────────────────────────────────────────────────────────────

export const actions = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  marginTop: '1.5rem',
  ...({ WebkitAppRegion: 'no-drag' } as CSSExtra),
});

// ── Separator (opt-in; the default header has none) ──────────────────────────

export const separator = style({
  height: '1px',
  backgroundColor: vars.borderSubtle,
  flexShrink: 0,
  marginTop: '1.75rem',
});
