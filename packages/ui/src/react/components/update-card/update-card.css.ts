import { style } from '@vanilla-extract/css';
import '@styles/layers.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const card = style({
  minWidth: 0,
  display: 'grid',
  gap: '0.75rem',
});

export const row = style({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
  width: '100%',
  borderRadius: tokenVars.radiusLg,
});

/** `bare`: a plain settings row (40px minimum, like `SettingsRow`), wraps when narrow. */
export const rowBare = style([
  row,
  {
    minHeight: '2.5rem',
    flexWrap: 'wrap',
    columnGap: '1rem',
    rowGap: '0.5rem',
  },
]);

export const rowBody = style({
  display: 'flex',
  minWidth: 0,
  flex: '1 1 16rem',
  flexDirection: 'column',
  gap: '0.25rem',
});

export const rowTitle = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: tokenVars.textSm,
  fontWeight: 400,
  color: vars.foreground,
});

export const rowDescription = style({
  display: 'flex',
  alignItems: 'center',
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const rowControls = style({
  marginLeft: 'auto',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
});

// An error reads as a quiet note, not a red panel (design brief 2.12): one surface
// step with a hairline; the message carries the error tone.
export const errorPanel = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  minWidth: 0,
  padding: '0.75rem',
  borderRadius: tokenVars.radiusLg,
  border: `1px solid ${vars.borderSubtle}`,
  backgroundColor: vars.surfaceEmphasis,
  color: vars.foregroundError,
});

export const errorMessage = style({
  fontSize: tokenVars.textSm,
  lineHeight: 1.5,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  userSelect: 'text',
});

export const errorActions = style({
  display: 'flex',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: '0.5rem',
});

export const errorDetails = style({
  flex: '1 1 12rem',
  minWidth: 0,
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
});

export const errorSummary = style({
  cursor: 'pointer',
  paddingBlock: '0.25rem',
});

export const errorDetailsText = style({
  marginTop: '0.5rem',
  maxHeight: '12rem',
  overflowY: 'auto',
  fontFamily: tokenVars.fontMono,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  lineHeight: 1.5,
  userSelect: 'text',
});
