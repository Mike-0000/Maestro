/**
 * block-frame.css.ts — base positioning for all block-level content.
 *
 * BlockFrame renders a div with this class. Block-kind-specific visual styles
 * are applied via a second class prop.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

export const pblock = style({
  position: 'absolute',
  left: 0,
  width: '100%',
  overflow: 'visible',
  // Ensure border-box sizing regardless of host preflight.
  boxSizing: 'border-box',
  // Skip layout/paint for off-screen blocks inside tall units (long messages,
  // code blocks, tables). The exact contain-intrinsic-size is set as an inline
  // style in BlockFrame using the measured height, so the browser reserves the
  // correct space while the block is skipped. On-screen blocks are unaffected
  // (content-visibility: auto removes containment for visible elements).
  contentVisibility: 'auto',
});

// ── Debug overlay ─────────────────────────────────────────────────────────────

export const debugOverlay = style({
  pointerEvents: 'none',
  position: 'absolute',
  inset: 0,
  outlineStyle: 'dashed',
  outlineWidth: '1px',
});

// Development-only layout overlay (Storybook "Debug on"); themed like everything else.
export const debugOk = style({
  outlineColor: `color-mix(in srgb, ${vars.link} 60%, transparent)`,
});

export const debugMismatch = style({
  outlineColor: vars.fgError,
});

export const debugLabel = style({
  position: 'absolute',
  top: 0,
  right: 0,
  background: vars.fg,
  paddingLeft: '4px',
  paddingRight: '4px',
  fontSize: '10px',
  lineHeight: 'tight',
  color: vars.bg,
});

export const debugMismatchText = style({
  color: vars.fgError,
});
