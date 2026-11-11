/**
 * theme.css.ts — VE global theme contract + chat-ui default theme.
 *
 * CONTRACT (vars)
 *   createGlobalThemeContract defines the stable public CSS variable names
 *   (--chat-fg, --chat-type-body-font-size, --chat-font-sans, ...) that every
 *   .css.ts file and host override preset depend on.
 *
 * DEFAULT THEME (createGlobalTheme × 2)
 *   The two createGlobalTheme calls are the chat-ui built-in default theme.
 *   Typography metric and chip-pad values are derived from DEFAULT_CONFIG so
 *   this file and the runtime buildChatTheme share the same single source of truth.
 *   Every color and radius reads the Maestro design-system token first
 *   (`var(--em-foreground, <literal>)`) and falls back to a literal copy of that
 *   token's value, so a host that loads the design system (the desktop app) and
 *   one that does not (Storybook, other hosts) render the same palette: one
 *   deep low-chroma slate ground, almost no lines, one jade accent.
 *   Specificity is zero (:where() selectors) so any host override wins
 *   regardless of stylesheet load order.
 *
 * HOST OVERRIDE
 *   A host may still rebind any --chat-* variable with an .emlight / .emdark
 *   rule. Prefer leaving colors to these defaults so the transcript and the rest
 *   of the app never disagree; rebind --chat-font-sans only together with a
 *   matching ChatConfig, because text is measured with the config's font.
 */

import { DEFAULT_CONFIG, toThemeVars } from '@core/config';
import { createGlobalTheme, createGlobalThemeContract } from '@vanilla-extract/css';

// ── Contract (stable public names) ────────────────────────────────────────────

// The second argument to createGlobalThemeContract is a mapFn that receives
// the leaf value and returns the CSS custom property name.
// We use the value itself as the name suffix so the TS key and CSS name are
// both visible: vars.fg compiles to var(--chat-fg).

export const vars = createGlobalThemeContract(
  {
    // ── Color palette ─────────────────────────────────────────────────────────
    fg: 'chat-fg',
    fgBody: 'chat-fg-body',
    fgMuted: 'chat-fg-muted',
    fgPassive: 'chat-fg-passive',
    bg: 'chat-bg',
    bg1: 'chat-bg-1',
    bg2: 'chat-bg-2',
    bg3: 'chat-bg-3',
    border: 'chat-border',
    /** The one hairline around a card or well that a surface step alone cannot separate. */
    borderSubtle: 'chat-border-subtle',
    /** Cards and output wells (code, command output, diffs): one step above the ground. */
    surfaceEmphasis: 'chat-surface-emphasis',
    /** Hover fill for quiet rows and buttons on the transcript ground. */
    surfaceHover: 'chat-surface-hover',
    /** Edge of an output well: the hairline in light, nothing in dark (the step suffices). */
    wellBorder: 'chat-well-border',
    /** Keyboard focus mark (accent, at least 3:1 on every surface). */
    focusRing: 'chat-focus-ring',
    /** The working pulse; the only other use of the accent besides links and focus. */
    accent: 'chat-accent',
    /** Warning text and glyphs (awaiting permission); never a fill. */
    fgWarning: 'chat-fg-warning',

    // User message card surface
    userCardBg: 'chat-user-card-bg',
    userCardBgHover: 'chat-user-card-bg-hover',
    userCardBorder: 'chat-user-card-border',
    userCardBorderHover: 'chat-user-card-border-hover',

    // Resolved context-mention pill — per-kind bg/fg vars
    mentionChipBg: 'chat-mention-chip-bg',
    mentionChipFg: 'chat-mention-chip-fg',
    mentionFileBg: 'chat-mention-file-bg',
    mentionFileFg: 'chat-mention-file-fg',
    mentionIssueBg: 'chat-mention-issue-bg',
    mentionIssueFg: 'chat-mention-issue-fg',
    mentionSymbolBg: 'chat-mention-symbol-bg',
    mentionSymbolFg: 'chat-mention-symbol-fg',
    mentionCustomBg: 'chat-mention-custom-bg',
    mentionCustomFg: 'chat-mention-custom-fg',

    // Diff surface
    diffAdded: 'chat-diff-added',
    diffDeleted: 'chat-diff-deleted',
    diffModified: 'chat-diff-modified',

    // Misc semantic
    fgError: 'chat-fg-error',
    link: 'chat-link',
    bubbleUser: 'chat-bubble-user',
    bubbleUserFg: 'chat-bubble-user-fg',
    mentionBg: 'chat-mention-bg',
    mentionFg: 'chat-mention-fg',
    codeBg: 'chat-code-bg',
    codeInlineBg: 'chat-code-inline-bg',
    tableHeaderBg: 'chat-table-header-bg',
    planDone: 'chat-plan-done',
    planActive: 'chat-plan-active',

    // ── Non-color design tokens ────────────────────────────────────────────────
    fontSans: 'chat-font-sans',
    fontMono: 'chat-font-mono',
    radiusXs: 'chat-radius-xs',
    radiusSm: 'chat-radius-sm',
    radiusMd: 'chat-radius-md',
    radiusLg: 'chat-radius-lg',
    radiusXl: 'chat-radius-xl',
    radiusFull: 'chat-radius-full',

    // ── Private typography (--chat-type-*) ────────────────────────────────────
    // These names must NOT change — prose.css.ts / diff.css.ts reference them
    // and any rename breaks the measure === offsetHeight invariant.
    typeBodyFontFamily: 'chat-type-body-font-family',
    typeBodyFontSize: 'chat-type-body-font-size',
    typeBodyFontWeight: 'chat-type-body-font-weight',
    typeBodyLineHeight: 'chat-type-body-line-height',

    typeBodyBoldFontFamily: 'chat-type-body-bold-font-family',
    typeBodyBoldFontSize: 'chat-type-body-bold-font-size',
    typeBodyBoldFontWeight: 'chat-type-body-bold-font-weight',
    typeBodyBoldLineHeight: 'chat-type-body-bold-line-height',

    typeBodyItalicFontFamily: 'chat-type-body-italic-font-family',
    typeBodyItalicFontSize: 'chat-type-body-italic-font-size',
    typeBodyItalicFontWeight: 'chat-type-body-italic-font-weight',
    typeBodyItalicFontStyle: 'chat-type-body-italic-font-style',
    typeBodyItalicLineHeight: 'chat-type-body-italic-line-height',

    typeBodyLinkFontFamily: 'chat-type-body-link-font-family',
    typeBodyLinkFontSize: 'chat-type-body-link-font-size',
    typeBodyLinkFontWeight: 'chat-type-body-link-font-weight',
    typeBodyLinkLineHeight: 'chat-type-body-link-line-height',

    typeH1FontFamily: 'chat-type-h1-font-family',
    typeH1FontSize: 'chat-type-h1-font-size',
    typeH1FontWeight: 'chat-type-h1-font-weight',
    typeH1LineHeight: 'chat-type-h1-line-height',

    typeH2FontFamily: 'chat-type-h2-font-family',
    typeH2FontSize: 'chat-type-h2-font-size',
    typeH2FontWeight: 'chat-type-h2-font-weight',
    typeH2LineHeight: 'chat-type-h2-line-height',

    typeH3FontFamily: 'chat-type-h3-font-family',
    typeH3FontSize: 'chat-type-h3-font-size',
    typeH3FontWeight: 'chat-type-h3-font-weight',
    typeH3LineHeight: 'chat-type-h3-line-height',

    typeInlineCodeFontFamily: 'chat-type-inline-code-font-family',
    typeInlineCodeFontSize: 'chat-type-inline-code-font-size',
    typeInlineCodeFontWeight: 'chat-type-inline-code-font-weight',
    typeInlineCodeLineHeight: 'chat-type-inline-code-line-height',

    typeCodeFontFamily: 'chat-type-code-font-family',
    typeCodeFontSize: 'chat-type-code-font-size',
    typeCodeFontWeight: 'chat-type-code-font-weight',
    typeCodeLineHeight: 'chat-type-code-line-height',

    typeCodeLangFontFamily: 'chat-type-code-lang-font-family',
    typeCodeLangFontSize: 'chat-type-code-lang-font-size',
    typeCodeLangFontWeight: 'chat-type-code-lang-font-weight',
    typeCodeLangLineHeight: 'chat-type-code-lang-line-height',

    // Mention chip typography (size/weight emitted at runtime like all other roles).
    typeMentionFontFamily: 'chat-type-mention-font-family',
    typeMentionFontSize: 'chat-type-mention-font-size',
    typeMentionFontWeight: 'chat-type-mention-font-weight',

    // ── Chip padding (runtime-settable by ChatRoot) ────────────────────────────
    icPadX: 'chat-ic-pad-x',
    icPadY: 'chat-ic-pad-y',
    mentionPadX: 'chat-mention-pad-x',
    mentionPadY: 'chat-mention-pad-y',
  },
  (value) => `--${value}`
);

// ── Shared non-color tokens ────────────────────────────────────────────────────
//
// Typography metrics and chip padding derive from DEFAULT_CONFIG via toThemeVars
// (same source of truth as buildChatTheme) so build-time defaults and runtime
// inline-var emission can never drift from each other. Both createGlobalTheme
// blocks spread these; each block then only lists its own color palette.
//
// Font-family and radius tokens are static across themes, so they live here too.
// The vars contract keys match the ThemeVarKey union in config.ts exactly —
// TypeScript enforces this in ChatRoot via vars[k as ThemeVarKey] lookups.

const NON_COLOR_VARS = {
  fontSans: ['Inter Variable', 'sans-serif'].join(', '),
  fontMono: "'JetBrains Mono Variable', 'JetBrains Mono', Menlo, Monaco, monospace",
  // The design system's radius scale: xs 4 (chips), sm 6 (mini buttons), md 8 (rows,
  // wells), lg 12 (cards, bubbles), xl 16.
  radiusXs: 'var(--em-radius-xs, 0.25rem)',
  radiusSm: 'var(--em-radius-sm, 0.375rem)',
  radiusMd: 'var(--em-radius-md, 0.5rem)',
  radiusLg: 'var(--em-radius-lg, 0.75rem)',
  radiusXl: 'var(--em-radius-xl, 1rem)',
  radiusFull: '9999px',
  // Typography + chip padding — all derived from DEFAULT_CONFIG.
  ...toThemeVars(DEFAULT_CONFIG),
};

// ── Palettes ──────────────────────────────────────────────────────────────────
//
// `tok('foreground', '…')` reads the design-system token and falls back to a
// literal copy of its generated value (packages/theme, dark.theme.ts and
// light.theme.ts). Keep the literals in step when the theme is retuned.

function tok(name: string, p3: string): string {
  return `var(--em-${name}, color(display-p3 ${p3}))`;
}

/** Roles that read the same token in both themes; only the fallback literal differs. */
function palette(p: {
  fg: string;
  n11: string;
  muted: string;
  passive: string;
  paper: string;
  paperHover: string;
  emphasis: string;
  bg1: string;
  bg2: string;
  bg3: string;
  border: string;
  borderSubtle: string;
  focusRing: string;
  link: string;
  accent: string;
  error: string;
  warning: string;
  added: string;
  deleted: string;
  modified: string;
  wellBorder: string;
  inlineCodeMix: string;
}) {
  const fg = tok('foreground', p.fg);
  const chip = tok('background-3', p.bg3);
  return {
    fg,
    fgBody: `var(--em-foreground-body, color-mix(in srgb, color(display-p3 ${p.n11}) 40%, color(display-p3 ${p.fg})))`,
    fgMuted: tok('foreground-muted', p.muted),
    fgPassive: tok('foreground-passive', p.passive),
    bg: tok('surface-paper', p.paper),
    bg1: tok('background-1', p.bg1),
    bg2: tok('background-2', p.bg2),
    bg3: tok('background-3', p.bg3),
    border: tok('border', p.border),
    borderSubtle: tok('border-subtle', p.borderSubtle),
    surfaceEmphasis: tok('surface-base-emphasis', p.emphasis),
    surfaceHover: tok('surface-paper-hover', p.paperHover),
    wellBorder: p.wellBorder,
    focusRing: tok('focus-ring', p.focusRing),
    accent: tok('accent', p.accent),
    fgWarning: tok('foreground-warning', p.warning),
    // What the developer wrote: a quiet bubble one step above the ground, as the
    // conductor thread draws it. No edge; hover lifts it one more step.
    userCardBg: tok('background-2', p.bg2),
    userCardBgHover: tok('background-3', p.bg3),
    userCardBorder: 'transparent',
    userCardBorderHover: 'transparent',
    // Mentions are neutral chips of every kind: color is kept for errors.
    mentionChipBg: chip,
    mentionChipFg: fg,
    mentionFileBg: chip,
    mentionFileFg: fg,
    mentionIssueBg: chip,
    mentionIssueFg: fg,
    mentionSymbolBg: chip,
    mentionSymbolFg: fg,
    mentionCustomBg: chip,
    mentionCustomFg: fg,
    diffAdded: tok('foreground-diff-added', p.added),
    diffDeleted: tok('foreground-diff-deleted', p.deleted),
    diffModified: tok('foreground-diff-modified', p.modified),
    fgError: tok('foreground-error', p.error),
    link: tok('link', p.link),
    bubbleUser: tok('background-2', p.bg2),
    bubbleUserFg: fg,
    mentionBg: chip,
    mentionFg: fg,
    codeBg: tok('surface-base-emphasis', p.emphasis),
    codeInlineBg: `color-mix(in srgb, ${fg} ${p.inlineCodeMix}, transparent)`,
    tableHeaderBg: 'transparent',
    // Plan entries speak the state language: done is passive, in progress is the
    // working accent, pending is passive and dotted.
    planDone: tok('foreground-passive', p.passive),
    planActive: tok('accent', p.accent),
  };
}

// ── Light theme ────────────────────────────────────────────────────────────────

createGlobalTheme(':where(:root), :where(.emlight)', vars, {
  ...palette({
    fg: '0.0743 0.0944 0.1069',
    n11: '0.2692 0.2967 0.3139',
    muted: '0.2692 0.2967 0.3139',
    passive: '0.3989 0.4282 0.4464',
    paper: '0.9888 0.9947 0.9984',
    paperHover: '0.9365 0.9422 0.9459',
    emphasis: '0.9757 0.9815 0.9852',
    bg1: '0.9596 0.9692 0.9753',
    bg2: '0.9355 0.9475 0.9551',
    bg3: '0.9102 0.9246 0.9336',
    border: '0.8549 0.8739 0.8858',
    borderSubtle: '0.885 0.9018 0.9122',
    focusRing: '0.2944 0.5701 0.497',
    link: '0.1837 0.4095 0.3514',
    accent: '0.1887 0.4494 0.3839',
    error: '0.8394 0.4028 0.3867',
    warning: '0.4681 0.3272 0',
    added: '0.3082 0.62 0.3061',
    deleted: '0.8394 0.4028 0.3867',
    modified: '0.7574 0.5441 0',
    // On the near-white ground the emphasis step alone is too faint for a well.
    wellBorder: tok('border-subtle', '0.885 0.9018 0.9122'),
    inlineCodeMix: '6%',
  }),
  ...NON_COLOR_VARS,
});

// ── Dark theme ─────────────────────────────────────────────────────────────────
// Only colors differ from light — typography and geometry are theme-independent.

createGlobalTheme(':where(.emdark)', vars, {
  ...palette({
    fg: '0.9269 0.9366 0.9426',
    n11: '0.6616 0.6866 0.7023',
    muted: '0.6616 0.6866 0.7023',
    passive: '0.5171 0.5499 0.5704',
    paper: '0.0798 0.0987 0.1103',
    paperHover: '0.1158 0.1354 0.1476',
    emphasis: '0.0976 0.1169 0.1287',
    bg1: '0.0921 0.118 0.134',
    bg2: '0.1102 0.1366 0.153',
    bg3: '0.1272 0.1559 0.1737',
    border: '0.1653 0.1949 0.2132',
    borderSubtle: '0.1461 0.1752 0.1933',
    focusRing: '0.3562 0.5739 0.5124',
    link: '0.5795 0.7748 0.716',
    accent: '0.4372 0.7152 0.6375',
    error: '0.871 0.4316 0.4136',
    warning: '0.8447 0.6914 0.3848',
    added: '0.3319 0.6441 0.3287',
    deleted: '0.871 0.4316 0.4136',
    modified: '0.8079 0.5927 0',
    // The emphasis step separates a well from the dark ground by itself.
    wellBorder: 'transparent',
    inlineCodeMix: '8%',
  }),
  ...NON_COLOR_VARS,
});
