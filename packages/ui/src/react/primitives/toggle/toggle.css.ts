import { style } from '@vanilla-extract/css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

/** Container for a group of Toggle buttons. */
export const toggleGroup = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.125rem',
  // A quiet track, like the PillTabs segmented control.
  borderRadius: `calc(${tokenVars.radiusMd} + 2px)`,
  backgroundColor: `color-mix(in srgb, ${vars.foreground} 5%, transparent)`,
  padding: '0.125rem',
});
