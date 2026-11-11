/**
 * copy-button.css.ts — styles for CopyButton.
 *
 * Two marker classes are exported so each reveal trigger is scoped to its own
 * context and cannot leak across nesting levels:
 *
 *   messageGroup — applied to the assistant message container; reveals the
 *                  inline footer copy button on hover.
 *   codeGroup    — applied to each code block (BlockFrame); reveals that
 *                  block's overlay copy button on hover, independently of
 *                  any sibling code blocks and of the message body hover.
 *
 * Scope guarantees:
 *   - Hovering the message body reveals only the footer inline button.
 *   - Hovering code block A reveals A's overlay only (not B's).
 *   - Hovering code block A also reveals the same message's footer button
 *     because A is a descendant of messageGroup — this is intentional.
 *   - Hover state is fully isolated between sibling messages and between
 *     sibling code blocks.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** Apply to the assistant message container to enable inline-button group-hover. */
export const messageGroup = style({});

/** Apply to each code block (BlockFrame) to enable overlay-button group-hover. */
export const codeGroup = style({});

const buttonBase = style({
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0,
  transition: 'opacity 150ms ease, color 150ms ease, background-color 150ms ease',
  userSelect: 'none',
  // Own reset: hosts without a preflight (Storybook) must render the same button.
  border: 0,
  background: 'transparent',
  font: 'inherit',
  color: vars.fgPassive,
  borderRadius: vars.radiusSm,
  outline: 'none',
  selectors: {
    '&:hover': { color: vars.fg, background: vars.surfaceHover },
    '&:focus-visible': {
      opacity: 1,
      color: vars.fg,
      boxShadow: `0 0 0 2px ${vars.focusRing}`,
    },
  },
});

export const copyButtonOverlay = style([
  buttonBase,
  {
    position: 'absolute',
    top: '6px',
    right: '6px',
    zIndex: 10,
    padding: '4px',
    // Sits on the code well: take the well's surface so it never sits on top of
    // a token mid-line unreadably.
    background: vars.surfaceEmphasis,
    selectors: {
      [`${codeGroup}:hover &`]: { opacity: 1 },
    },
  },
]);

export const copyButtonInline = style([
  buttonBase,
  {
    gap: '4px',
    padding: '2px 4px',
    marginLeft: '-4px',
    fontSize: '0.75rem',
    selectors: {
      [`${messageGroup}:hover &`]: { opacity: 1 },
    },
  },
]);
