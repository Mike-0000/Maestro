/**
 * composer-contract.css.ts — ChatComposer theme contract.
 *
 * Emits, scoped to `composerThemeScope` under :where(.emlight)/:where(.emdark),
 * a bridge that maps every --em-* custom property read by the ChatComposer
 * subtree (Button, SplitButton, PromptEditor, notice band, permission band,
 * portaled dropdown) to a var(--composer-*, <polarity default>) expression.
 *
 * This makes the full composer subtree re-themeable by the host via a small,
 * documented --composer-* set, without the host importing @emdash/ui's color
 * theme sheets (theme.css / semantic.css).
 *
 * SCOPING
 * ───────
 * The bridge only applies inside elements carrying `composerThemeScope`.
 * ChatComposer puts the class on its root AND on every surface it portals out
 * of its DOM subtree (agent/model/permission dropdowns, MCP and context-usage
 * popovers, effort submenu, prompt-editor suggestion popups) — portals mount
 * under <body>, so they would otherwise escape a root-scoped bridge. Keeping
 * the redefinitions scoped means the host's app-wide --em-* values stay owned
 * by the theme sheets; the composer contract never leaks document-wide.
 * (Host --composer-* inputs are typically set on the theme root and inherit
 * into the portaled surfaces just fine.)
 *
 * The defaults resolve to the generated @emdash/theme palette ramps (the
 * --em-neutral-*, --em-accent-*, --em-red-* … steps each slot maps to), so the
 * composer follows whichever theme is active in Storybook (where the theme
 * sheets ARE imported) and in any host that does not override --composer-*.
 *
 * PUBLIC CONTRACT — --composer-* variables
 * ─────────────────────────────────────────
 * Set any of these on a selector that inherits to the composer root to re-theme:
 *
 * Core foregrounds:
 *   --composer-fg                  main text color
 *   --composer-fg-muted            secondary / label text
 *   --composer-fg-passive          placeholder text
 *
 * Borders:
 *   --composer-border              default border color
 *   --composer-border-strong       hover / focus-within border
 *   --composer-border-focus        focus-ring outline color
 *
 * Surfaces (elevation ramp — base is the popup/menu bg, elevated is the shell):
 *   --composer-surface             base surface (menus, attachment remove btn)
 *   --composer-surface-hover       hover tint on base surface
 *   --composer-surface-selected    selected tint on base surface
 *   --composer-surface-elevated    elevated shell background (composer border bg)
 *   --composer-surface-elevated-hover  elevated shell hover tint
 *
 * Primary / send button (accent):
 *   --composer-accent              accent button background
 *   --composer-accent-hover        accent button hover background
 *   --composer-accent-fg           accent button foreground
 *   --composer-accent-border       accent button border
 *
 * Destructive / stop button:
 *   --composer-fg-destructive      destructive text and ghost-destructive color
 *   --composer-destructive-bg      primary-destructive button background
 *   --composer-border-destructive  primary-destructive button border / focus ring
 *   --composer-destructive-hover   primary/ghost destructive hover background
 *   --composer-destructive-selected primary/ghost destructive active background
 *
 * Error notice band (and primary-destructive ghost hover context):
 *   --composer-error-surface       error band background
 *   --composer-error-border        error band border
 *   --composer-error-fg            error band foreground
 *
 * Warning notice band:
 *   --composer-fg-warning          warning text
 *   --composer-warning-surface     warning band background
 *   --composer-warning-border      warning band border
 *   --composer-warning-surface-fg  warning band foreground
 *
 * Info notice band:
 *   --composer-fg-info             info text
 *   --composer-info-surface        info band background
 *   --composer-info-border         info band border
 *   --composer-info-surface-fg     info band foreground
 *
 * Legacy single-property override (pre-contract, still honoured):
 *   --composer-bg                  overrides the shell background directly
 *                                  (takes priority over --composer-surface-elevated)
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';

/**
 * Scope marker for the composer theme bridge. ChatComposer applies it to its
 * root element and to every portaled surface it renders (see SCOPING above).
 * The rules stay unlayered on purpose: the bridge redefines --em-* slots that
 * semantic.css declares inside `@layer tokens`, and staying unlayered keeps
 * the bridge authoritative regardless of where a host mounts the theme class.
 */
export const composerThemeScope = style({});

// Zero-specificity theme-conditional selectors for the scoped bridge. The
// theme class always sits above the scoped element (<html>, or a wrapper-mode
// provider element), so a descendant combinator is sufficient.
const lightScope = `:where(.emlight) :where(${composerThemeScope})`;
const darkScope = `:where(.emdark) :where(${composerThemeScope})`;

// ── Defaults ───────────────────────────────────────────────────────────────────
// Each fallback points at the generated palette step the semantic template
// resolves that slot to (packages/theme/src/core/contract/semantic-template.ts),
// so an un-themed host and Storybook render the current theme in any colour
// mode. The bridge cannot fall back to the slot it redefines (for example
// `--em-foreground: var(--composer-fg, var(--em-foreground))` is a cycle and
// resolves to nothing), which is why the fallbacks name ramp steps instead.

/** Ramp-step reference: `ramp('neutral', 12)` → `var(--em-neutral-12)`. */
const ramp = (scale: string, step: number | 'contrast') => `var(--em-${scale}-${step})`;
const bridge = (input: string, fallback: string) => `var(${input}, ${fallback})`;

/** Polarity-independent slots (foregrounds, borders, accent, status rooms). */
const sharedDefaults = {
  // Core foregrounds
  [vars.foreground]: bridge('--composer-fg', ramp('neutral', 12)),
  [vars.foregroundMuted]: bridge('--composer-fg-muted', ramp('neutral', 11)),
  [vars.foregroundPassive]: bridge('--composer-fg-passive', ramp('neutral', 9)),

  // Borders
  [vars.border]: bridge('--composer-border', ramp('neutral', 6)),
  [vars.border1]: bridge('--composer-border-strong', ramp('neutral', 7)),
  [vars.borderPrimary]: bridge('--composer-border-focus', ramp('neutral', 9)),
  [vars.borderDestructive]: bridge('--composer-border-destructive', ramp('red', 8)),

  // Primary / send button
  [vars.primaryButtonBackground]: bridge('--composer-accent', ramp('accent', 9)),
  [vars.primaryButtonBackgroundHover]: bridge('--composer-accent-hover', ramp('accent', 10)),
  [vars.primaryButtonForeground]: bridge('--composer-accent-fg', ramp('accent', 'contrast')),
  [vars.primaryButtonBorder]: bridge('--composer-accent-border', ramp('accent', 7)),

  // Destructive / stop button + ghost-destructive
  [vars.foregroundDestructive]: bridge('--composer-fg-destructive', ramp('red', 11)),
  [vars.backgroundDestructive]: bridge('--composer-destructive-bg', ramp('red', 3)),
  [vars.surfaceDestructiveHover]: bridge('--composer-destructive-hover', ramp('red', 4)),
  [vars.surfaceDestructiveSelected]: bridge('--composer-destructive-selected', ramp('red', 5)),

  // Error notice band (surface-destructive is also the ghost-destructive room)
  [vars.surfaceDestructive]: bridge('--composer-error-surface', ramp('red', 3)),
  [vars.surfaceDestructiveBorder]: bridge('--composer-error-border', ramp('red', 6)),
  [vars.surfaceDestructiveForeground]: bridge('--composer-error-fg', ramp('red', 11)),

  // Warning notice band
  [vars.foregroundWarning]: bridge('--composer-fg-warning', ramp('amber', 11)),
  [vars.surfaceWarning]: bridge('--composer-warning-surface', ramp('amber', 3)),
  [vars.surfaceWarningBorder]: bridge('--composer-warning-border', ramp('amber', 6)),
  [vars.surfaceWarningForeground]: bridge('--composer-warning-surface-fg', ramp('amber', 11)),

  // Info notice band
  [vars.foregroundInfo]: bridge('--composer-fg-info', ramp('blue', 9)),
  [vars.surfaceInfo]: bridge('--composer-info-surface', ramp('blue', 3)),
  [vars.surfaceInfoBorder]: bridge('--composer-info-border', ramp('blue', 6)),
  [vars.surfaceInfoForeground]: bridge('--composer-info-surface-fg', ramp('blue', 11)),
};

// Surface level vars (the cascade vars --em-surface/hover/selected in
// surfaces.css.ts default to var(--em-surface-base) etc., so bridging the level
// vars is sufficient to drive the full surface cascade). The neutral steps that
// sit closest to each generated surface differ per polarity.

globalStyle(lightScope, {
  vars: {
    ...sharedDefaults,
    [vars.surfaceBase]: bridge('--composer-surface', ramp('neutral', 2)),
    [vars.surfaceBaseHover]: bridge('--composer-surface-hover', ramp('neutral', 4)),
    [vars.surfaceBaseSelected]: bridge('--composer-surface-selected', ramp('neutral', 6)),
    [vars.surfaceBaseEmphasis]: bridge('--composer-surface-elevated', ramp('neutral', 1)),
    [vars.surfaceBaseEmphasisHover]: bridge(
      '--composer-surface-elevated-hover',
      ramp('neutral', 3)
    ),
  },
});

globalStyle(darkScope, {
  vars: {
    ...sharedDefaults,
    [vars.surfaceBase]: bridge('--composer-surface', ramp('neutral', 1)),
    [vars.surfaceBaseHover]: bridge('--composer-surface-hover', ramp('neutral', 3)),
    [vars.surfaceBaseSelected]: bridge('--composer-surface-selected', ramp('neutral', 5)),
    [vars.surfaceBaseEmphasis]: bridge('--composer-surface-elevated', ramp('neutral', 2)),
    [vars.surfaceBaseEmphasisHover]: bridge(
      '--composer-surface-elevated-hover',
      ramp('neutral', 4)
    ),
  },
});
