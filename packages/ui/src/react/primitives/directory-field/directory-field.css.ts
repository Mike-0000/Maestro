import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const layout = style({
  appearance: 'none',
  display: 'flex',
  width: '100%',
  height: '2rem',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.5rem',
  margin: 0,
  paddingTop: 0,
  paddingRight: '0.25rem',
  paddingBottom: 0,
  paddingLeft: '0.625rem',
  font: 'inherit',
  fontSize: tokenVars.textSm,
  textAlign: 'left',
  cursor: 'pointer',
});

export const layoutSm = style({
  height: '1.5rem',
  paddingLeft: '0.5rem',
  fontSize: tokenVars.textXs,
});

export const icon = style({
  pointerEvents: 'none',
  flexShrink: 0,
  color: vars.foregroundPassive,
});
globalStyle(`${icon}:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const value = style({
  minWidth: 0,
  width: '100%',
  flex: 1,
  overflow: 'hidden',
  color: vars.foreground,
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
});

/**
 * A path truncates at its start, so the folder name (the part that tells two
 * paths apart) stays visible: `…/repos/emdash` rather than `/Users/da…`.
 *
 * The line runs right-to-left, so its overflow (and the ellipsis) falls on the
 * left edge, while `text-align: left` keeps a path that fits at the left. The
 * path itself sits in an LTR isolate (`<bdi dir="ltr">`), so its characters,
 * slashes and drive letters keep their order; the DOM text is untouched, so
 * the accessible name and any copy of it read the full path in order.
 */
export const valuePath = style({
  direction: 'rtl',
  textAlign: 'left',
});

export const placeholder = style({
  color: vars.foregroundPassive,
});

export const chooseAffordance = style({
  pointerEvents: 'none',
});
