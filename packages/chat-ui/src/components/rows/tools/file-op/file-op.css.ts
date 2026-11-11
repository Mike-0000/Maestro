import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { sx } from '@styles/sprinkles.css';
import { vars } from '@styles/theme.css';
import { createVariableThemeContract } from '@styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

/**
 * Contract for the file-op card vars. `height` is set on the root by the def;
 * `padY` is set locally by FileOpList / FileOpPreviewBody where it is consumed
 * via `padding-block`.
 */
export type FileOpStyleVars = {
  height: number;
  padY: number;
};

export const fileOpCardVars = createVariableThemeContract<FileOpStyleVars>({
  height: null,
  padY: null,
});

export const fileOpRoot = style({ height: fileOpCardVars.height });

/** Marker for a file row that opens its file (keys the name's hover style). */
const fileRowLink = style({});

/** The file's name: the one word in the row worth reading, a step above the verb. */
export const fileName = style({
  color: vars.fgMuted,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textDecorationLine: 'underline',
  textDecorationColor: 'transparent',
  textUnderlineOffset: '4px',
  transition: 'color 150ms, text-decoration-color 150ms',
  selectors: {
    [`${fileRowLink}:hover &`]: {
      color: vars.fg,
      textDecorationColor: `color-mix(in srgb, ${vars.fgMuted} 60%, transparent)`,
    },
    // Keyboard focus: the accent underline every quiet text row uses.
    [`${fileRowLink}:focus-visible &`]: {
      color: vars.fg,
      textDecorationColor: vars.focusRing,
      textDecorationThickness: '2px',
    },
  },
});

/** "Read  login.ts": the verb passive, the file name muted; a link when it opens the file. */
export const fileRow = recipe({
  base: [
    sx({
      display: 'flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'fgPassive',
      fontSize: 'sm',
    }),
    { minWidth: 0, maxWidth: '100%', outline: 'none' },
  ],
  variants: {
    clickable: {
      true: [
        fileRowLink,
        {
          cursor: 'pointer',
        },
      ],
      false: {},
    },
  },
});

export const fileOpHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  color: vars.fgPassive,
  fontSize: vars.typeBodyFontSize,
  userSelect: 'none',
  selectors: {
    '&:hover': { color: vars.fgMuted },
  },
});

/** "Read…" while the first path has not arrived yet. */
export const monoRunning = style({
  fontSize: vars.typeBodyFontSize,
  color: vars.fgPassive,
});

/** Single-file op wrapper — flex row, full height. */
export const singleOpRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
});

export const chevronSm = recipe({
  base: {
    display: 'inline-block',
    fontSize: '0.875rem',
    transition: 'transform 150ms ease-out',
  },
  variants: {
    expanded: {
      true: { transform: 'rotate(90deg)' },
      false: {},
    },
  },
});
