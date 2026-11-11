import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';
// Colocated chip-class styles — global selectors for TipTap-serialized HTML.
import './chip-classes.css';

// The prompt reads in the UI-body role (13px) with the conductor composer's line height, so a
// one-line prompt and its placeholder sit at the same height in both composers.
const LINE_HEIGHT = 1.5;

export const editorWrapper = style({
  position: 'relative',
  width: '100%',
});

export const editorContent = style({
  width: '100%',
  outline: 'none',
});

export const editorPlaceholder = style({
  pointerEvents: 'none',
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textSm,
  lineHeight: LINE_HEIGHT,
  userSelect: 'none',
  color: vars.foregroundPassive,
});

/** A devicon file glyph in the suggestion list keeps its file-type tint; sized like a 14px icon. */
export const popupFileIcon = style({
  fontSize: '0.8125rem',
  lineHeight: 1,
});

export const popupKindIcon = style({ width: '0.875rem', height: '0.875rem' });

// These classes are assigned via TipTap editorProps.attributes.class
export const promptEditorContentClass = style({
  outline: 'none',
  fontSize: tokenVars.textSm,
  lineHeight: LINE_HEIGHT,
  color: vars.foreground,
  // A host (ChatComposer's minRows) can ask for a taller resting editor.
  minHeight: `var(--composer-editor-min-height, ${LINE_HEIGHT}em)`,
  overflowWrap: 'anywhere',
});
