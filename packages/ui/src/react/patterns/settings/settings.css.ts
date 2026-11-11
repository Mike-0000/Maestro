import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// Settings family (design brief 2.8): a section title in the section-title
// role, 12px above one card on the emphasis surface (rounded-lg, one subtle
// hairline), rows inside separated by space rather than rules: label and
// helper text on the left, the control on the right, vertically centred.

export const card = style({
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: tokenVars.radiusLg,
  border: `1px solid ${vars.borderSubtle}`,
  // The card is the emphasis step of whatever surface it sits on, and its
  // contents resolve the cascade against it (same as the .surface-emphasis scope).
  backgroundColor: vars.surfaceEmphasis,
  color: vars.foreground,
  padding: '1rem',
  vars: {
    [vars.surface]: vars.surfaceEmphasis,
    [vars.surfaceHover]: vars.surfaceEmphasisHover,
    [vars.surfaceSelected]: vars.surfaceEmphasisSelected,
    [vars.surfaceInput]: `color-mix(in srgb, ${vars.surfaceEmphasis} 94%, ${vars.foreground})`,
  },
});

/** Card padding when it holds settings rows: rows bring their own vertical rhythm. */
export const cardRows = style({
  paddingBlock: '0.5rem',
  paddingInline: '1rem',
});

export const body = style({
  display: 'flex',
  flexDirection: 'column',
});

export const section = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
});

/** The rows stack inside the card (no rules; see `separated` to opt back in). */
export const rows = style({
  display: 'flex',
  flexDirection: 'column',
});

// Aligns the heading with the card's inner content (card padding is 1rem).
export const sectionTitle = style({
  paddingInline: '1rem',
  margin: 0,
  color: vars.foreground,
});

/** One sentence under a section title. */
export const sectionDescription = style({
  paddingInline: '1rem',
  marginTop: '-0.5rem',
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundMuted,
});

/**
 * A settings row: at least 40px tall, label block and control vertically
 * centred. Rows in a section sit 20px apart (the section's `gap`) inside the
 * card's 16px padding, so adjacent rows read about 56-60px apart.
 */
export const row = style({
  minHeight: '2.5rem',
});

/** Stacked row: label and helper over a full-width control (paths, URLs, keys). */
export const rowStacked = style({
  gap: '0.375rem',
});

export const rowStackedControl = style({
  display: 'flex',
  width: '100%',
  minWidth: 0,
  marginTop: '0.25rem',
});
