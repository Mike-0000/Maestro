import { style } from '@vanilla-extract/css';
import { vars } from '@styles/theme.css';

/** Story viewport box — sizes the scroll viewport for chat stories (one hairline frame). */
export const storyViewport = style({
  border: `1px solid ${vars.borderSubtle}`,
  background: vars.bg,
  overflow: 'hidden',
  borderRadius: vars.radiusLg,
});

/** Caption above each row of a state matrix ("Running", "Error"), in the group-label role. */
export const storyRowLabel = style({
  fontFamily: vars.fontSans,
  fontSize: '11px',
  color: vars.fgPassive,
  marginBottom: '6px',
  paddingLeft: '2px',
});
