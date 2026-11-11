import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { vars } from '@theme/core/contract/contract.css';

// ── Drag-region helpers ───────────────────────────────────────────────────────

// Electron's -webkit-app-region is not a standard CSS property; cast to sneak
// it past vanilla-extract's type checker.
type CSSExtra = { [key: string]: string };

export const dragRegion = style({
  ...({ WebkitAppRegion: 'drag' } as CSSExtra),
});

export const noDragRegion = style({
  ...({ WebkitAppRegion: 'no-drag' } as CSSExtra),
});

// ── Root outer / scroll container ─────────────────────────────────────────────

export const outer = style({
  display: 'flex',
  height: '100%',
  minHeight: 0,
  width: '100%',
  flex: '1 1 0%',
  flexDirection: 'column',
  overflow: 'hidden',
});

export const scroll = style({
  height: '100%',
  overflowX: 'hidden',
  overflowY: 'auto',
  scrollbarGutter: 'stable',
  // A size container, so the sticky sidebar can be exactly as tall as this scroll box (100cqh):
  // 100vh overflowed it whenever the view is shorter than the window (title bar, voice bar
  // reserve) and scrolled the whole layout, sidebar included.
  containerType: 'size',
});

// ── Centered page container ───────────────────────────────────────────────────

/** Sidebar + content two-column grid (Library / Settings style). */
export const containerGrid = style({
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
  maxWidth: '1060px',
  paddingLeft: '2rem',
  paddingRight: '2rem',
  display: 'grid',
  gridTemplateColumns: '13rem minmax(0, 1fr)',
  gap: '2rem',
});

/** Single centered column (Automations style). */
export const containerSingle = style({
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
  maxWidth: '56rem', // ~896px = Tailwind max-w-4xl
  paddingLeft: '2rem',
  paddingRight: '2rem',
});

// ── Sidebar sticky wrapper ─────────────────────────────────────────────────────

export const sidebarWrapper = style({
  position: 'sticky',
  top: 0,
  alignSelf: 'start',
  boxSizing: 'border-box',
  display: 'flex',
  minHeight: '100cqh',
  maxHeight: '100cqh',
  flexDirection: 'column',
  paddingTop: '2.5rem',
  paddingBottom: '0.75rem',
});

// ── Content container recipe ──────────────────────────────────────────────────

export const content = recipe({
  base: {
    marginLeft: 'auto',
    marginRight: 'auto',
    width: '100%',
    paddingLeft: '1rem',
    paddingRight: '1rem',
  },
  variants: {
    maxWidth: {
      sm: { maxWidth: '24rem' },
      md: { maxWidth: '28rem' },
      lg: { maxWidth: '32rem' },
      xl: { maxWidth: '36rem' },
      '2xl': { maxWidth: '42rem' },
      '3xl': { maxWidth: '48rem' },
      '4xl': { maxWidth: '56rem' },
      full: { maxWidth: '100%' },
    },
  },
  defaultVariants: {
    maxWidth: '4xl',
  },
});

export type ContentVariants = NonNullable<RecipeVariants<typeof content>>;

// ── Background fill (used by sticky header and root) ─────────────────────────

export const bgFill = style({
  backgroundColor: vars.background,
});
