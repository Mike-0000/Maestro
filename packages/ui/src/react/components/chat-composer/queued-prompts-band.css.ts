import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// Queued prompts at the top of the composer field: a caption in the group-label role, then one
// quiet row per prompt. Rows separate by rhythm and a hover fill, never rules; the number turns
// into a drag handle and the row actions appear on hover or keyboard focus.

export const band = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: 0,
  paddingTop: '0.5rem',
  paddingBottom: '0.375rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  color: vars.foreground,
  fontSize: tokenVars.textSm,
});

export const header = style({
  margin: 0,
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '0.75rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.25rem',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundPassive,
});

export const headerStrong = style({
  color: vars.foregroundMuted,
});

export const headerCount = style({
  fontVariantNumeric: 'tabular-nums',
});

export const headerHint = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'right',
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
});

export const row = style({
  display: 'grid',
  position: 'relative',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '1.75rem',
  borderRadius: tokenVars.radiusMd,
  paddingLeft: '0.375rem',
  paddingRight: '0.25rem',
  outline: 'none',
  cursor: 'text',
  transition: 'background-color 150ms',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
    '&:focus-within': { backgroundColor: vars.surfaceHover },
    '&[data-dragging]': {
      opacity: 0.56,
    },
    '&[data-drag-over]': {
      backgroundColor: vars.surfaceSelected,
    },
  },
});

export const indexSlot = style({
  position: 'relative',
  width: '1rem',
  height: '1rem',
  flexShrink: 0,
});

export const indexNumber = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: tokenVars.textXs,
  color: vars.foregroundPassive,
  fontVariantNumeric: 'tabular-nums',
  transition: 'opacity 120ms',
  selectors: {
    [`${row}:hover &`]: { opacity: 0 },
    [`${row}:focus-within &`]: { opacity: 0 },
    [`${row}[data-dragging] &`]: { opacity: 0 },
  },
});

export const dragHandle = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: tokenVars.radiusSm,
  backgroundColor: 'transparent',
  padding: 0,
  color: vars.foregroundPassive,
  cursor: 'grab',
  opacity: 0,
  outline: 'none',
  transition: 'opacity 120ms, color 120ms, background-color 120ms',
  selectors: {
    [`${row}:hover &`]: { opacity: 1 },
    [`${row}:focus-within &`]: { opacity: 1 },
    [`${row}[data-dragging] &`]: { opacity: 1, cursor: 'grabbing' },
    '&:hover': {
      backgroundColor: vars.surfaceSelected,
      color: vars.foreground,
    },
    '&:focus-visible': {
      opacity: 1,
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '0px',
    },
  },
});

export const dragHandleIcon = style({
  width: '0.875rem',
  height: '0.875rem',
});

export const promptText = style({
  minWidth: 0,
  border: 0,
  borderRadius: tokenVars.radiusSm,
  backgroundColor: 'transparent',
  padding: 0,
  color: vars.foreground,
  font: 'inherit',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: tokenVars.textSmLineHeight,
  outline: 'none',
  cursor: 'text',
  selectors: {
    '&:focus-visible': {
      outline: `2px solid ${vars.focusRing}`,
      outlineOffset: '1px',
    },
  },
});

export const emptyText = style({
  color: vars.foregroundMuted,
  fontStyle: 'italic',
});

export const actions = style({
  position: 'absolute',
  right: '0.125rem',
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  paddingLeft: '0.75rem',
  borderRadius: tokenVars.radiusMd,
  // Covers the end of a long prompt while the actions show; matches the row's hover fill.
  backgroundColor: vars.surfaceHover,
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms',
  selectors: {
    [`${row}:hover &`]: { opacity: 1, pointerEvents: 'auto' },
    [`${row}:focus-within &`]: { opacity: 1, pointerEvents: 'auto' },
  },
});

export const editArea = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  minWidth: 0,
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
});

export const editInput = style({
  flex: 1,
  minWidth: 0,
  resize: 'none',
  fieldSizing: 'content',
  maxHeight: '7rem',
  border: `1px solid ${vars.border}`,
  borderRadius: tokenVars.radiusMd,
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
  backgroundColor: vars.surfaceInput,
  color: vars.foreground,
  font: 'inherit',
  lineHeight: tokenVars.textSmLineHeight,
  outline: 'none',
  transition: 'border-color 150ms, box-shadow 150ms',
  selectors: {
    '&:focus': {
      borderColor: vars.focusRing,
      boxShadow: `0 0 0 1px ${vars.focusRing}`,
    },
  },
});
