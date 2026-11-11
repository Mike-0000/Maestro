import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// Element styles for the two Markdown variants. The full variant reads like a
// document (reading body 14/1.6 in foreground-body, headings by size and weight
// alone, no rules under them); the compact variant is denser for previews and
// comment bodies and inherits its size from the host.
//
// Structure comes from space and the surface step, not lines: code wells sit
// on the emphasis surface with one hairline, quotes are a quiet left rule,
// tables separate rows with a subtle hairline only.

/** Code wells, inline code and table heads sit one step above the surface. */
const well = vars.surfaceEmphasis;
const hairline = `1px solid ${vars.borderSubtle}`;

// ── Shared ────────────────────────────────────────────────────────────────────

export const link = style({
  color: vars.link,
  textDecoration: 'underline',
  textUnderlineOffset: '3px',
  textDecorationThickness: '1px',
  textDecorationColor: `color-mix(in srgb, ${vars.link} 40%, transparent)`,
  transition: 'text-decoration-color 150ms',
  borderRadius: tokenVars.radiusXs,
  outline: 'none',
  selectors: {
    '&:hover': { textDecorationColor: vars.link },
    '&:focus-visible': { boxShadow: `0 0 0 2px ${vars.focusRing}` },
  },
});

export const strong = style({
  fontWeight: 600,
  color: vars.foreground,
});

export const taskCheckbox = style({
  marginRight: '0.5rem',
  verticalAlign: 'middle',
  pointerEvents: 'none',
  selectors: {
    // readOnly instead of disabled so the checked state keeps full contrast.
    '&:checked': { accentColor: vars.primaryButtonBackground },
  },
});

export const listItem = style({
  lineHeight: 1.6,
  selectors: {
    '& + &': { marginTop: '0.25rem' },
  },
});

// ── Full variant ──────────────────────────────────────────────────────────────

const headingBase = {
  fontWeight: 600,
  color: vars.foreground,
  textWrap: 'balance',
} as const;

export const h1Full = style({
  ...headingBase,
  marginTop: '2rem',
  marginBottom: '0.75rem',
  fontSize: tokenVars.textXl,
  lineHeight: tokenVars.textXlLineHeight,
  letterSpacing: '-0.01em',
  selectors: { '&:first-child': { marginTop: 0 } },
});

export const h2Full = style({
  ...headingBase,
  marginTop: '1.75rem',
  marginBottom: '0.625rem',
  fontSize: tokenVars.textLg,
  lineHeight: tokenVars.textLgLineHeight,
  selectors: { '&:first-child': { marginTop: 0 } },
});

export const h3Full = style({
  ...headingBase,
  marginTop: '1.25rem',
  marginBottom: '0.5rem',
  fontSize: tokenVars.textBase,
  lineHeight: tokenVars.textBaseLineHeight,
  selectors: { '&:first-child': { marginTop: 0 } },
});

export const h4Full = style({
  ...headingBase,
  marginTop: '1rem',
  marginBottom: '0.375rem',
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
});

export const h5Full = style({
  ...headingBase,
  marginTop: '0.75rem',
  marginBottom: '0.25rem',
  fontSize: tokenVars.textSm,
});

export const h6Full = style({
  ...headingBase,
  marginTop: '0.75rem',
  marginBottom: '0.25rem',
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
});

const readingBody = {
  fontSize: tokenVars.textBase,
  lineHeight: tokenVars.textBaseLineHeight,
  color: vars.foregroundBody,
} as const;

export const paragraphFull = style({
  ...readingBody,
  marginBottom: '0.875rem',
});

export const unorderedListFull = style({
  ...readingBody,
  marginBottom: '0.875rem',
  marginLeft: '1.25rem',
  listStyleType: 'disc',
});

export const orderedListFull = style({
  ...readingBody,
  marginBottom: '0.875rem',
  marginLeft: '1.25rem',
  listStyleType: 'decimal',
});

globalStyle(`${unorderedListFull} > li::marker, ${orderedListFull} > li::marker`, {
  color: vars.foregroundPassive,
});

export const inlineCodeFull = style({
  backgroundColor: well,
  borderRadius: tokenVars.radiusXs,
  paddingInline: '0.3em',
  paddingBlock: '0.1em',
  fontFamily: tokenVars.fontMono,
  fontSize: '0.86em',
  color: vars.foreground,
});

export const preFull = style({
  marginBottom: '0.875rem',
  overflowX: 'auto',
  borderRadius: tokenVars.radiusLg,
  border: hairline,
  backgroundColor: well,
});

export const codeBlockFull = style({
  display: 'block',
  padding: '0.75rem 1rem',
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textXs,
  lineHeight: 1.6,
});

export const blockquoteFull = style({
  ...readingBody,
  marginBottom: '0.875rem',
  borderLeft: `2px solid ${vars.border}`,
  paddingLeft: '1rem',
  color: vars.foregroundMuted,
});

export const tableWrapperFull = style({
  marginBottom: '0.875rem',
  overflowX: 'auto',
});

export const tableFull = style({
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: tokenVars.textSm,
  lineHeight: tokenVars.textSmLineHeight,
});

export const tableHeadFull = style({
  borderBottom: hairline,
});

export const tableHeaderCellFull = style({
  paddingInline: '0.75rem',
  paddingBlock: '0.5rem',
  textAlign: 'left',
  fontSize: tokenVars.textXs,
  fontWeight: 500,
  color: vars.foregroundMuted,
  selectors: { '&:first-child': { paddingLeft: 0 } },
});

export const tableCellFull = style({
  borderTop: hairline,
  paddingInline: '0.75rem',
  paddingBlock: '0.5rem',
  verticalAlign: 'top',
  color: vars.foregroundBody,
  selectors: { '&:first-child': { paddingLeft: 0 } },
});

export const dividerFull = style({
  marginBlock: '1.75rem',
  border: 'none',
  borderTop: hairline,
});

export const imageContainerFull = style({
  marginBlock: '0.875rem',
});

export const imageFull = style({
  maxWidth: '100%',
  borderRadius: tokenVars.radiusMd,
});

export const imagePlaceholder = style({
  display: 'inline-block',
  marginBlock: '0.75rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundPassive,
});

// ── Compact variant ───────────────────────────────────────────────────────────

export const h1Compact = style({
  ...headingBase,
  marginTop: '0.75rem',
  marginBottom: '0.25rem',
  fontSize: tokenVars.textSm,
  selectors: { '&:first-child': { marginTop: 0 } },
});

export const h3Compact = style({
  ...headingBase,
  marginTop: '0.5rem',
  marginBottom: '0.25rem',
  fontSize: tokenVars.textXs,
});

export const paragraphCompact = style({
  marginBottom: '0.5rem',
  lineHeight: 1.6,
});

export const unorderedListCompact = style({
  marginBottom: '0.5rem',
  marginLeft: '1rem',
  listStyleType: 'disc',
});

export const orderedListCompact = style({
  marginBottom: '0.5rem',
  marginLeft: '1rem',
  listStyleType: 'decimal',
});

// List markers live on the li children; both elements are owned by this
// component, so the descendant globalStyle stays within its boundary.
globalStyle(`${unorderedListCompact} > li::marker, ${orderedListCompact} > li::marker`, {
  color: vars.foregroundPassive,
});

export const inlineCodeCompact = style({
  backgroundColor: well,
  borderRadius: tokenVars.radiusXs,
  paddingInline: '0.25rem',
  paddingBlock: '0.0625rem',
  fontFamily: tokenVars.fontMono,
  fontSize: '0.9em',
});

export const codeBlockCompact = style({
  display: 'block',
  overflowX: 'auto',
  borderRadius: tokenVars.radiusMd,
  border: hairline,
  backgroundColor: well,
  padding: '0.5rem 0.625rem',
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textTiny,
  lineHeight: 1.6,
});

export const preCompact = style({
  marginBottom: '0.5rem',
  overflowX: 'auto',
});

export const blockquoteCompact = style({
  marginBottom: '0.5rem',
  borderLeft: `2px solid ${vars.border}`,
  paddingLeft: '0.75rem',
  color: vars.foregroundMuted,
});

export const tableWrapperCompact = style({
  marginBlock: '0.75rem',
  overflowX: 'auto',
  borderRadius: tokenVars.radiusMd,
  border: hairline,
});

export const tableCompact = style({
  width: '100%',
  minWidth: 'max-content',
  borderCollapse: 'collapse',
  textAlign: 'left',
  fontSize: tokenVars.textTiny,
  lineHeight: 1.4,
});

export const tableHeadCompact = style({
  backgroundColor: well,
  borderBottom: hairline,
  color: vars.foregroundMuted,
});

export const tableHeaderCellCompact = style({
  paddingInline: '0.625rem',
  paddingBlock: '0.375rem',
  fontWeight: 500,
});

export const tableCellCompact = style({
  borderTop: hairline,
  paddingInline: '0.625rem',
  paddingBlock: '0.375rem',
  verticalAlign: 'top',
});

export const dividerCompact = style({
  marginBlock: '1rem',
  border: 'none',
  borderTop: hairline,
});

export const linkCompact = style([
  link,
  {
    textUnderlineOffset: '2px',
  },
]);

export const imageContainerCompact = style({
  marginBlock: '0.5rem',
});

export const imageCompact = style({
  height: 'auto',
  maxHeight: '20rem',
  maxWidth: '100%',
  borderRadius: tokenVars.radiusMd,
});

// ── Mermaid ───────────────────────────────────────────────────────────────────

export const mermaidPreviewContainer = style({
  position: 'relative',
  overflowX: 'auto',
  borderRadius: tokenVars.radiusLg,
  border: hairline,
  backgroundColor: well,
});

export const mermaidExpandButton = style({
  position: 'absolute',
  top: '0.375rem',
  right: '0.375rem',
  zIndex: 10,
  opacity: 0,
  transition: 'opacity 150ms',
  backgroundColor: vars.surfaceElevated,
  boxShadow: `${vars.shadowSm}, 0 0 0 1px ${vars.borderSubtle}`,
  selectors: {
    [`${mermaidPreviewContainer}:hover &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
  },
});

export const mermaidPreview = style({
  minWidth: 'fit-content',
  cursor: 'zoom-in',
  padding: '0.75rem',
  color: vars.foreground,
});

export const mermaidPreviewCompact = style({
  padding: '0.5rem',
});

export const mermaidDialogContent = style({
  color: vars.foreground,
});

// The SVG markup is injected by this component via dangerouslySetInnerHTML,
// so these descendant rules do not cross a component boundary.
globalStyle(`${mermaidPreview} svg`, { display: 'block', height: 'auto', maxWidth: '100%' });
globalStyle(`${mermaidDialogContent} svg`, { display: 'block', height: 'auto', maxWidth: 'none' });

// A failed diagram reads as a quiet note, not a red panel: the title carries
// the error tone, the source sits in a mono well under it.
export const mermaidError = style({
  marginBlock: '0.75rem',
  borderRadius: tokenVars.radiusLg,
  border: hairline,
  backgroundColor: well,
  padding: '0.75rem 1rem',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const mermaidErrorCompact = style({
  marginBlock: '0.5rem',
  padding: '0.5rem 0.625rem',
  fontSize: tokenVars.textTiny,
});

export const mermaidErrorTitle = style({
  fontWeight: 500,
  color: vars.foregroundError,
});

export const mermaidErrorMessage = style({
  marginTop: '0.25rem',
  color: vars.foregroundMuted,
});

export const mermaidErrorSource = style({
  marginTop: '0.5rem',
  overflowX: 'auto',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.surface,
  padding: '0.5rem',
  fontFamily: tokenVars.fontMono,
  color: vars.foregroundMuted,
});
