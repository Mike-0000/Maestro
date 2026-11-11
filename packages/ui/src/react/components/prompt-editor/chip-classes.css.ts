/**
 * Semantic class names assigned by the TipTap mention and slash-command
 * extensions. These classes need to exist in style.css so that the serialized
 * HTML from ProseMirror (used in clipboard/copy scenarios) can be styled
 * correctly as serialized HTML from ProseMirror.
 *
 * They match the live pills (mention-pill.css.ts): the inline-code well — a
 * quiet fill, rounded-xs, caption-sized text — with no outline.
 */
import { globalStyle } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

const chip = {
  display: 'inline',
  fontSize: tokenVars.textXs,
  fontWeight: 400,
  borderRadius: tokenVars.radiusXs,
  paddingLeft: '0.25rem',
  paddingRight: '0.25rem',
  paddingTop: '0.0625rem',
  paddingBottom: '0.0625rem',
  backgroundColor: `color-mix(in srgb, ${vars.foreground} 8%, transparent)`,
  color: vars.foreground,
  verticalAlign: 'baseline',
} as const;

// Applied to mention chip DOM elements in the serialized HTML representation.
globalStyle('.mention-chip', chip);

// Applied to slash-command chip DOM elements in the serialized HTML representation.
globalStyle('.slash-command-chip', chip);
