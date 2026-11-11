/**
 * effects.css.ts — ports the @utility effects from the old tokens.css §3.
 *
 * text-shimmer, fade-overlay-top/bottom, and plan-spinner are now typed VE
 * style objects. Components import the class names directly instead of using
 * Tailwind utility strings.
 *
 * The keyframe names are scoped by VE so they never collide in the host app.
 */

import { createVar, fallbackVar, keyframes, style } from '@vanilla-extract/css';
import { vars } from './theme.css';

// ── Keyframes ─────────────────────────────────────────────────────────────────

const shimmerMove = keyframes({
  from: { backgroundPosition: '200% 0' },
  to: { backgroundPosition: '-200% 0' },
});

const planSpin = keyframes({
  to: { transform: 'rotate(360deg)' },
});

const fadeIn = keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.35 },
});

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * The surface a fade overlay melts into. Defaults to the transcript ground; a
 * row drawn on a card or well sets it to that surface so the fade matches.
 */
export const fadeSurface = createVar();

// ── text-shimmer ──────────────────────────────────────────────────────────────

export const textShimmer = style({
  background: `linear-gradient(
    90deg,
    ${vars.fgPassive} 0%,
    ${vars.fgPassive} 30%,
    ${vars.fgMuted} 50%,
    ${vars.fgPassive} 70%,
    ${vars.fgPassive} 100%
  )`,
  backgroundSize: '200% 100%',
  backgroundClip: 'text',
  WebkitBackgroundClip: 'text',
  color: 'transparent',
  WebkitTextFillColor: 'transparent',
  animation: `${shimmerMove} 3s linear infinite`,
  '@media': {
    // Still text in the muted tone: the words ("Running", "Thinking 4s") carry it.
    [REDUCED_MOTION]: {
      animation: 'none',
      background: 'none',
      color: vars.fgMuted,
      WebkitTextFillColor: 'currentColor',
    },
  },
});

// ── working pulse ─────────────────────────────────────────────────────────────

/** The working glyph: a small accent dot that pulses (held still under reduced motion). */
export const workingDot = style({
  display: 'inline-block',
  width: '6px',
  height: '6px',
  flexShrink: 0,
  borderRadius: vars.radiusFull,
  background: vars.accent,
  animation: `${pulse} 2s ease-in-out infinite`,
  '@media': {
    [REDUCED_MOTION]: { animation: 'none' },
  },
});

// ── fade-overlay-top ──────────────────────────────────────────────────────────

const fadeColor = fallbackVar(fadeSurface, vars.bg);

export const fadeOverlayTop = style({
  background: `linear-gradient(
    to bottom,
    ${fadeColor} 0%,
    color-mix(in oklab, ${fadeColor}, transparent 50%) 40%,
    color-mix(in oklab, ${fadeColor}, transparent 100%) 100%
  )`,
});

// ── fade-overlay-bottom ───────────────────────────────────────────────────────

export const fadeOverlayBottom = style({
  background: `linear-gradient(
    to top,
    ${fadeColor} 0%,
    color-mix(in oklab, ${fadeColor}, transparent 50%) 40%,
    color-mix(in oklab, ${fadeColor}, transparent 100%) 100%
  )`,
});

// ── stream-word ───────────────────────────────────────────────────────────────

/**
 * Duration of the per-word fade-in. Override on any ancestor (e.g. ChatRoot or
 * a story container) to tune the effect without rebuilding the stylesheet.
 */
export const streamWordDuration = createVar();

/**
 * Applied to each newly-revealed word span during streaming. A pure paint-only
 * fade (`opacity`), so it never reflows: pretext geometry and the reserved
 * block height are untouched. `inline-block` keeps exact character widths inside
 * the `white-space: pre` fragment.
 */
export const streamWord = style({
  display: 'inline-block',
  // easeOutCubic — a soft, decelerating curve so words settle gently.
  animation: `${fadeIn} ${fallbackVar(streamWordDuration, '200ms')} cubic-bezier(0.215, 0.61, 0.355, 1) both`,
  '@media': {
    [REDUCED_MOTION]: { animation: 'none' },
  },
});

// ── plan-spinner ──────────────────────────────────────────────────────────────

export const planSpinner = style({
  transformOrigin: 'center',
  transformBox: 'fill-box',
  animation: `${planSpin} 1s linear infinite`,
  '@media': {
    [REDUCED_MOTION]: { animation: 'none' },
  },
});
