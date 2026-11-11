import { style, styleVariants } from '@vanilla-extract/css';
import { fadeSurface } from '@styles/effects.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type CollapsibleCardStyleVars = {
  height: number;
};

export const collapsibleCardVars = createVariableThemeContract<CollapsibleCardStyleVars>({
  height: null,
});

// ── Card shell ────────────────────────────────────────────────────────────────
//
// The 1px edge is part of the measured geometry (rows count it), so every
// appearance keeps its width and only chooses whether it draws.

const shell = style({
  borderWidth: '1px',
  borderStyle: 'solid',
  overflow: 'hidden',
  boxSizing: 'border-box',
  height: collapsibleCardVars.height,
});

/**
 * Card appearances:
 *  - `card`: a quiet card (emphasis surface, one hairline), for an artifact the
 *    developer reads as a whole, such as the plan.
 *  - `bare`: no box at all. The header reads as one quiet row aligned with the
 *    transcript text (the shell pulls out by the header's padding so its hover
 *    fill has room), and the body supplies its own well. Used by commands.
 */
export const collapsibleCard = styleVariants({
  card: [
    shell,
    {
      borderColor: vars.borderSubtle,
      borderRadius: vars.radiusLg,
      background: vars.surfaceEmphasis,
      vars: { [fadeSurface]: vars.surfaceEmphasis },
    },
  ],
  bare: [
    shell,
    {
      borderColor: 'transparent',
      borderRadius: vars.radiusMd,
      marginLeft: '-9px',
      marginRight: '-9px',
    },
  ],
});

export type CollapsibleCardAppearance = keyof typeof collapsibleCard;
