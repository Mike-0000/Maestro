import { style, styleVariants } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { svgContainer } from '@styles/effects/svg-helpers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// The composer reads like the conductor's: one bordered field that grows with what is typed (the
// emphasis step, rounded-lg, one hairline, an accent ring while typing), the attach and send
// controls inside it, and the agent's settings as quiet facts on one line beneath it. A pending
// permission request and queued prompts become sections at the top of the same field; a notice
// about the last turn is one quiet line above it (a glyph and words, never a tinted panel).

/** The accent ring the conductor composer draws while the field has focus (`ring-3 ring/25`). */
const focusHalo = `0 0 0 3px color-mix(in srgb, ${vars.focusRing} 25%, transparent)`;

/** A quiet fill for rows and chips inside the field, independent of the surface cascade. */
const quietFill = `color-mix(in srgb, ${vars.foreground} 7%, transparent)`;

export const composerRoot = style({
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
});

// ── Notice line (above the field) ─────────────────────────────────────────────

export const noticeAnimWrapper = style({
  display: 'grid',
  transition: 'grid-template-rows 200ms ease-out, opacity 200ms ease-out',
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const noticeAnimVisible = style({ gridTemplateRows: '1fr', opacity: 1 });
export const noticeAnimHidden = style({ gridTemplateRows: '0fr', opacity: 0 });

export const noticeOverflowClip = style({ overflow: 'hidden', minHeight: 0 });

export const noticeLine = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.25rem',
  paddingBottom: '0.5rem',
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
});

/** A 16px slot, one text line tall, that centres the notice's mark on the first line. */
export const noticeGlyph = style({
  display: 'flex',
  width: '1rem',
  height: '1.125rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
});

export const noticeMark = styleVariants({
  // The error dot, the same mark as StateGlyph state="error".
  error: {
    width: '0.5rem',
    height: '0.5rem',
    borderRadius: '9999px',
    backgroundColor: vars.foregroundError,
  },
  warning: { width: '0.875rem', height: '0.875rem', color: vars.foregroundWarning },
  info: { width: '0.875rem', height: '0.875rem', color: vars.foregroundPassive },
});

export const noticeText = style({
  flex: 1,
  minWidth: 0,
  margin: 0,
  overflowWrap: 'anywhere',
});

export const noticeTitle = style({
  fontWeight: 500,
  color: vars.foreground,
});

export const noticeDismiss = style({
  marginTop: '-0.1875rem',
});

// ── The field ─────────────────────────────────────────────────────────────────

/** The editor's row; the field rings while focus is in it. */
export const editorRow = style({
  display: 'flex',
  minWidth: 0,
});
export const field = recipe({
  base: {
    vars: {
      // The field is a card on its surface: its own fill is the emphasis step, and the rows,
      // chips and ghost buttons inside hover one step above it rather than the page's hover.
      [vars.surface]: vars.surfaceEmphasis,
      [vars.surfaceHover]: vars.surfaceEmphasisHover,
      [vars.surfaceSelected]: vars.surfaceEmphasisSelected,
    },
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    // The emphasis step of the surface the composer sits on; hosts may override `--composer-bg`.
    backgroundColor: `var(--composer-bg, ${vars.surfaceEmphasis})`,
    border: `1px solid ${vars.border}`,
    borderRadius: tokenVars.radiusLg,
    transition: 'border-color 150ms, box-shadow 150ms',
    selectors: {
      [`&:has(${editorRow}:focus-within)`]: { borderColor: vars.focusRing, boxShadow: focusHalo },
    },
    '@media': {
      '(prefers-reduced-motion: reduce)': { transition: 'none' },
    },
  },
  variants: {
    dragActive: {
      true: { borderColor: vars.focusRing, boxShadow: focusHalo },
      false: {},
    },
    disabled: {
      true: { backgroundColor: 'transparent' },
      false: {},
    },
  },
  defaultVariants: { dragActive: false, disabled: false },
});

/** A section at the top of the field (permission request, queued prompts). */
export const fieldSection = style({
  borderBottom: `1px solid ${vars.borderSubtle}`,
});

// ── Image attachments ─────────────────────────────────────────────────────────

export const attachmentStrip = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  paddingLeft: '1rem',
  paddingRight: '1rem',
  paddingTop: '0.75rem',
});

export const attachmentThumb = style({
  position: 'relative',
  width: '2.5rem',
  height: '2.5rem',
});

export const attachmentThumbBtn = style({
  display: 'block',
  width: '2.5rem',
  height: '2.5rem',
  padding: 0,
  border: 'none',
  background: 'none',
  borderRadius: tokenVars.radiusMd,
  outline: 'none',
  selectors: {
    '&:focus-visible': { outline: `2px solid ${vars.focusRing}`, outlineOffset: '1px' },
  },
});

export const attachmentThumbImg = style({
  display: 'block',
  width: '2.5rem',
  height: '2.5rem',
  borderRadius: tokenVars.radiusMd,
  objectFit: 'cover',
  boxShadow: `0 0 0 1px ${vars.borderSubtle}`,
});

export const attachmentRemoveBtn = style([
  svgContainer,
  {
    position: 'absolute',
    top: '-0.375rem',
    right: '-0.375rem',
    display: 'grid',
    placeItems: 'center',
    width: '1.125rem',
    height: '1.125rem',
    padding: 0,
    border: 'none',
    borderRadius: '9999px',
    backgroundColor: vars.surfaceElevatedEmphasis,
    color: vars.foreground,
    boxShadow: `0 0 0 1px ${vars.borderSubtle}`,
    opacity: 0,
    outline: 'none',
    transition: 'opacity 150ms',
    selectors: {
      // Shown while the thumbnail is hovered or anything in it has keyboard focus.
      '[data-attachment-thumb]:hover &': { opacity: 1 },
      '[data-attachment-thumb]:focus-within &': { opacity: 1 },
      '&:focus-visible': { outline: `2px solid ${vars.focusRing}`, outlineOffset: '1px' },
    },
  },
]);

export const attachmentRemoveIcon = style({ width: '0.625rem', height: '0.625rem' });

// ── Editor row ────────────────────────────────────────────────────────────────

/**
 * The editor's scroll viewport: grows with the text up to 15rem, then scrolls. A host can ask for
 * a taller resting field with the minRows prop (or --composer-editor-min-height).
 */
export const editorArea = style({
  flex: 1,
  minWidth: 0,
  maxHeight: '15rem',
  overflowY: 'auto',
  paddingLeft: '1rem',
  paddingRight: '1rem',
  paddingTop: '0.75rem',
  paddingBottom: '0.25rem',
});
export const stopIcon = style({
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '0.125rem',
  backgroundColor: 'currentColor',
});

// ── Footer (inside the field, under the editor) ───────────────────────────────

/** The field's footer: the agent's settings on the left; context, attach and send on the right. */
export const tools = style({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '0.5rem',
  minWidth: 0,
  minHeight: '2.25rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.375rem',
  paddingBottom: '0.375rem',
});

export const toolsStart = style({
  display: 'flex',
  flex: 1,
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.125rem',
  minWidth: 0,
  minHeight: '1.75rem',
});

export const toolsEnd = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  gap: '0.125rem',
  minHeight: '1.75rem',
});
/** One quiet setting in the tools row: caption-sized, muted, full strength on hover or open. */
export const toolTrigger = style([
  svgContainer,
  {
    display: 'inline-flex',
    height: '1.75rem',
    minWidth: 0,
    maxWidth: '16rem',
    alignItems: 'center',
    gap: '0.375rem',
    border: '1px solid transparent',
    borderRadius: tokenVars.radiusMd,
    paddingLeft: '0.5rem',
    paddingRight: '0.5rem',
    backgroundColor: 'transparent',
    fontSize: tokenVars.textXs,
    lineHeight: 1,
    fontWeight: 400,
    color: vars.foregroundMuted,
    outline: 'none',
    transition: 'background-color 150ms, color 150ms',
    selectors: {
      '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
      '&[data-popup-open]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
      '&:focus-visible': { outline: `2px solid ${vars.focusRing}`, outlineOffset: '1px' },
      '&:disabled, &[data-disabled]': { opacity: 0.5, pointerEvents: 'none' },
    },
  },
]);

/** The words inside a tool trigger: truncate rather than push the row wider. */
export const toolLabel = style({
  display: 'inline-flex',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.375rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.25,
});

export const toolText = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const toolIcon = style({
  display: 'inline-flex',
  flexShrink: 0,
  width: '0.875rem',
  height: '0.875rem',
  color: vars.foregroundPassive,
});

/** "Model…" / "Permissions…" before a value is known. */
export const toolPlaceholder = style({ color: vars.foregroundPassive });

export const selectedModelEffort = style({
  color: vars.foregroundPassive,
});

// ── Mode select popup rows ────────────────────────────────────────────────────

export const modeItem = style({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
});

export const modeItemName = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textSm,
});

export const modeItemDescription = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textXs,
  color: vars.foregroundPassive,
});

// ── MCP servers ───────────────────────────────────────────────────────────────

export const mcpTrigger = style({
  selectors: {
    '&[data-failed]': { color: vars.foregroundError },
    '&[data-failed]:hover': { color: vars.foregroundError },
  },
});

export const mcpPopoverContent = style({
  width: '16rem',
  padding: '0.25rem',
});

export const mcpList = style({
  display: 'flex',
  flexDirection: 'column',
});

export const mcpRow = style({
  display: 'flex',
  minHeight: '2rem',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  borderRadius: tokenVars.radiusMd,
  padding: '0.25rem 0.5rem',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
  selectors: {
    '&[data-failed]': { color: vars.foregroundError },
  },
});

export const mcpNameGroup = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  minWidth: 0,
});

export const mcpName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const mcpInfoIcon = style({
  transform: 'translateY(1px)',
});

export const mcpErrorText = style({
  minWidth: 0,
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
});

/** The transport, as a caption after the name ("stdio", "http"). */
export const mcpBadge = style({
  flexShrink: 0,
  fontSize: tokenVars.textXs,
  color: vars.foregroundPassive,
  selectors: {
    '&[data-failed]': { color: vars.foregroundError },
  },
});

// ── Agent trigger ─────────────────────────────────────────────────────────────

export const agentTrigger = style({
  display: 'flex',
  width: '1.75rem',
  height: '1.75rem',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  color: vars.foreground,
  outline: 'none',
  transition: 'background-color 150ms',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
    '&[data-popup-open]': { backgroundColor: vars.surfaceSelected },
    '&:focus-visible': { outline: `2px solid ${vars.focusRing}`, outlineOffset: '1px' },
  },
});

export const agentIconPlaceholder = style({
  display: 'block',
  width: '0.875rem',
  height: '0.875rem',
  borderRadius: tokenVars.radiusXs,
  backgroundColor: quietFill,
});

export const agentOptionIcon = style({ display: 'inline-flex', flexShrink: 0 });

export const agentOptionName = style({
  minWidth: 0,
  flex: '1 1 0%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// ── Model detail card ─────────────────────────────────────────────────────────

export const modelItemName = style({
  flex: '1 1 0%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textSm,
});

export const modelDetailCard = style({
  width: '14rem',
  padding: '0.75rem',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
});

export const modelDetailName = style({
  margin: 0,
  lineHeight: tokenVars.textSmLineHeight,
  fontWeight: 500,
});

export const modelDetailDesc = style({
  margin: 0,
  marginTop: '0.25rem',
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
});

export const modelDetailFeatures = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  marginTop: '0.75rem',
});

export const modelDetailRow = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  fontSize: tokenVars.textXs,
});

export const modelDetailLabel = style({ color: vars.foregroundMuted });
export const modelDetailValue = style({
  color: vars.foreground,
  fontVariantNumeric: 'tabular-nums',
});

export const barMeter = style({ display: 'flex', alignItems: 'center', gap: '0.1875rem' });

export const barDotFilled = style({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '9999px',
  background: vars.foregroundMuted,
});

export const barDotEmpty = style({
  width: '0.375rem',
  height: '0.375rem',
  borderRadius: '9999px',
  background: quietFill,
});

// ── Context usage indicator ────────────────────────────────────────────────────

export const usageTrigger = style({
  fontVariantNumeric: 'tabular-nums',
});

/** Donut SVG — sized to sit with the caption text in the tools row. */
export const donut = style({
  width: '0.875rem',
  height: '0.875rem',
  display: 'block',
  flexShrink: 0,
  overflow: 'visible',
});

/** Background track ring. */
export const donutTrack = style({ stroke: vars.border1, opacity: 0.6 });

/** Fill ring — normal state. */
export const donutProgress = style({ stroke: vars.foregroundMuted });

/** Fill ring — nearly full (>= 90%). */
export const donutProgressWarn = style({ stroke: vars.foregroundWarning });

export const usagePopoverBody = style({
  width: '15rem',
});

export const usageStatsRow = style({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '1rem',
  fontSize: tokenVars.textXs,
});

export const usagePercent = style({
  fontSize: tokenVars.textSm,
  fontWeight: 500,
  color: vars.foreground,
  fontVariantNumeric: 'tabular-nums',
});

export const usageTokenCount = style({
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
});

export const usageBarTrack = style({
  marginTop: '0.5rem',
  height: '0.25rem',
  overflow: 'hidden',
  borderRadius: '9999px',
  backgroundColor: quietFill,
});

export const usageBarFill = style({
  height: '100%',
  borderRadius: '9999px',
  backgroundColor: vars.foregroundMuted,
});

export const usageBarFillWarn = style({
  backgroundColor: vars.foregroundWarning,
});

/** Cost row shown below the bar when cost is available. */
export const usageCostRow = style({
  marginTop: '0.75rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
  fontVariantNumeric: 'tabular-nums',
});

// ── Effort row (footer inside the model popover) ───────────────────────────────

/**
 * Full-width row rendered in the model popover footer that acts as the trigger
 * for the effort/thought-level submenu flyout. Mirrors a menu row.
 */
export const effortRow = style({
  display: 'flex',
  width: '100%',
  minHeight: '2rem',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  borderRadius: tokenVars.radiusMd,
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
  background: 'transparent',
  border: 'none',
  cursor: 'default',
  outline: 'none',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-popup-open]': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&:focus-visible': { backgroundColor: vars.surfaceHover, color: vars.foreground },
  },
});

export const effortRowLabel = style({
  color: 'inherit',
});

export const effortRowValue = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  color: vars.foregroundPassive,
  fontSize: tokenVars.textXs,
});

export const effortRowChevron = style({ width: '0.75rem', height: '0.75rem', flexShrink: 0 });
