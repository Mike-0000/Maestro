import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { svgContainer, svgSmSize } from '@styles/effects/svg-helpers.css';
import { LIGHT_THEME_SCOPE } from '@styles/recipes/field-shell.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

const motion = {
  transitionDuration: '200ms',
  transitionTimingFunction: 'ease-out',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transitionDuration: '0ms',
    },
  },
} as const;

// PillTabs is the segmented control (design brief 2.13.12): one quiet track,
// the chosen segment lifted one surface step with full-strength text.
export const list = style({
  '@layer': {
    recipes: {
      display: 'flex',
      width: '100%',
      alignItems: 'stretch',
      gap: '2px',
      padding: '2px',
      borderRadius: `calc(${tokenVars.radiusMd} + 2px)`,
      backgroundColor: `color-mix(in srgb, ${vars.foreground} 5%, transparent)`,
    },
  },
});

export const slot = recipe({
  base: {
    '@layer': {
      recipes: {
        display: 'flex',
        minWidth: 0,
        transitionProperty: 'flex-grow, flex-basis',
        ...motion,
      },
    },
  },
  variants: {
    compact: {
      false: {
        '@layer': {
          recipes: {
            flexBasis: 0,
            flexGrow: 1,
            flexShrink: 1,
          },
        },
      },
      true: {
        '@layer': {
          recipes: {
            flexBasis: '6rem',
            flexGrow: 0,
            flexShrink: 0,
          },
        },
      },
    },
  },
  defaultVariants: {
    compact: false,
  },
});

export const tab = style([
  {
    '@layer': {
      recipes: {
        display: 'inline-flex',
        width: '100%',
        minWidth: 0,
        height: '1.75rem',
        paddingInline: '0.75rem',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: tokenVars.radiusMd,
        backgroundColor: 'transparent',
        color: vars.foregroundMuted,
        font: 'inherit',
        cursor: 'pointer',
        outline: 'none',
        transition: 'background-color 150ms, box-shadow 150ms, color 150ms',
        selectors: {
          '&:hover:not([data-disabled]):not([aria-disabled="true"])': {
            color: vars.foreground,
          },
          '&[data-selected], &[aria-selected="true"]': {
            backgroundColor: vars.surfaceElevatedEmphasis,
            boxShadow: `0 0 0 1px ${vars.borderSubtle}`,
            color: vars.foreground,
          },
          [`${LIGHT_THEME_SCOPE} &[data-selected], ${LIGHT_THEME_SCOPE} &[aria-selected="true"]`]: {
            backgroundColor: vars.surfaceElevated,
            boxShadow: `${vars.shadowSm}, 0 0 0 1px ${vars.borderSubtle}`,
          },
          '&:disabled, &[data-disabled], &[aria-disabled="true"]': {
            cursor: 'not-allowed',
            opacity: 0.5,
          },
          '&:focus-visible': {
            outline: `2px solid ${vars.focusRing}`,
            outlineOffset: '1px',
          },
        },
      },
    },
  },
]);

export const content = style({
  '@layer': {
    recipes: {
      display: 'flex',
      width: '100%',
      minWidth: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
  },
});

export const icon = style([
  svgContainer,
  svgSmSize,
  {
    '@layer': {
      recipes: {
        display: 'inline-flex',
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
      },
    },
  },
]);

export const label = recipe({
  base: {
    '@layer': {
      recipes: {
        minWidth: 0,
        overflow: 'hidden',
        fontSize: tokenVars.textSm,
        lineHeight: 1.25,
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        transitionProperty: 'max-width, margin-left, opacity',
        ...motion,
      },
    },
  },
  variants: {
    hidden: {
      false: {
        '@layer': {
          recipes: {
            maxWidth: '16rem',
            marginLeft: '0.375rem',
            opacity: 1,
          },
        },
      },
      true: {
        '@layer': {
          recipes: {
            maxWidth: 0,
            marginLeft: 0,
            opacity: 0,
          },
        },
      },
    },
  },
  defaultVariants: {
    hidden: false,
  },
});
