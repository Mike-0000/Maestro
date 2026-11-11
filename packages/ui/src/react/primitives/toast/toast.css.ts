/**
 * Toast styling — restyles sonner onto the --em-* token contract.
 *
 * Sonner themes itself through CSS custom properties declared on
 * `[data-sonner-toaster][data-sonner-theme=…]` selectors and styles its
 * internals via data-attribute selectors on DOM it owns. Its only theming
 * hooks are those variables and CSS targeting those attributes, so the
 * overrides below are attribute-scoped globalStyles by necessity (this is
 * third-party DOM, not an @emdash/ui component boundary). Every selector is
 * anchored on the doubled `toaster` class so it outranks sonner's injected
 * stylesheet regardless of insertion order.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const toaster = style({
  selectors: {
    // (0,3,0) — beats sonner's (0,2,0) theme-default variable declarations.
    '&&[data-sonner-toaster]': {
      fontFamily: tokenVars.fontSans,
      vars: {
        // The elevated surface every floating layer shares (brief 2.10).
        '--normal-bg': vars.surfaceElevated,
        '--normal-border': vars.borderSubtle,
        '--normal-text': vars.foreground,
        '--border-radius': tokenVars.radiusLg,
      },
    },
  },
});

const scope = `${toaster}${toaster}[data-sonner-toaster]`;
const toastEl = `${scope} [data-sonner-toast][data-styled='true']`;

globalStyle(toastEl, {
  boxShadow: `${vars.shadowMd}, 0 0 0 1px ${vars.borderSubtle}`,
  borderColor: 'transparent',
  padding: '0.75rem 1rem',
  gap: '0.625rem',
});

// Title: 13px medium. Body: 12px muted.
globalStyle(`${toastEl} [data-title]`, {
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
  fontWeight: 500,
  color: vars.foreground,
});

// Sonner hardcodes description colors per light/dark theme; own them instead.
globalStyle(`${toastEl} [data-description]`, {
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
});

// State reads from the glyph, not from colour: only an error and a warning
// carry tone (brief 2.6); success and info glyphs stay neutral.
const TONE_ICON_COLORS = {
  success: vars.foregroundMuted,
  error: vars.foregroundError,
  warning: vars.foregroundWarning,
  info: vars.foregroundPassive,
} as const;

for (const [type, color] of Object.entries(TONE_ICON_COLORS)) {
  globalStyle(`${scope} [data-sonner-toast][data-type='${type}'] [data-icon]`, { color });
}

// Promise-toast loading spinner bars (sonner defaults them to its gray ramp).
globalStyle(`${scope} .sonner-loading-bar`, {
  backgroundColor: vars.foregroundMuted,
});

// The one action reads as a quiet text action (underlined, muted), like the
// kit's Button variant="text".
globalStyle(`${toastEl} [data-button]`, {
  height: 'auto',
  padding: 0,
  marginLeft: 'auto',
  backgroundColor: 'transparent',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
  fontWeight: 400,
  textDecorationLine: 'underline',
  textUnderlineOffset: '4px',
  textDecorationColor: `color-mix(in srgb, ${vars.foregroundPassive} 60%, transparent)`,
  cursor: 'pointer',
  transition: 'color 150ms',
});

globalStyle(`${toastEl} [data-button]:hover`, {
  color: vars.foreground,
  textDecorationColor: vars.foregroundMuted,
});

globalStyle(`${toastEl} [data-button]:focus-visible`, {
  outline: `2px solid ${vars.focusRing}`,
  outlineOffset: '2px',
  borderRadius: tokenVars.radiusSm,
  boxShadow: 'none',
});
