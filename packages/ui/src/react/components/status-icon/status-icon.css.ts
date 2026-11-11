import '@styles/layers.css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

// A status tile reads by its glyph on one neutral step (design brief 2.6): only an
// error and a warning colour the glyph; success reads full strength, info and
// neutral muted. No tinted tiles.
const quietTile = `color-mix(in srgb, ${vars.foreground} 7%, transparent)`;

export const statusIcon = recipe({
  base: {
    '@layer': {
      recipes: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokenVars.radiusSm,
        flexShrink: 0,
        backgroundColor: quietTile,
      },
    },
  },
  variants: {
    severity: {
      success: {
        '@layer': {
          recipes: {
            color: vars.foreground,
          },
        },
      },
      error: {
        '@layer': {
          recipes: {
            color: vars.foregroundError,
          },
        },
      },
      warning: {
        '@layer': {
          recipes: {
            color: vars.foregroundWarning,
          },
        },
      },
      info: {
        '@layer': {
          recipes: {
            color: vars.foregroundMuted,
          },
        },
      },
      neutral: {
        '@layer': {
          recipes: {
            color: vars.foregroundMuted,
          },
        },
      },
    },
    size: {
      sm: {
        '@layer': {
          recipes: {
            width: '1.25rem',
            height: '1.25rem',
          },
        },
      },
      md: {
        '@layer': {
          recipes: {
            width: '1.5rem',
            height: '1.5rem',
          },
        },
      },
      lg: {
        '@layer': {
          recipes: {
            width: '2.25rem',
            height: '2.25rem',
            borderRadius: tokenVars.radiusMd,
          },
        },
      },
    },
  },
  defaultVariants: {
    severity: 'neutral',
    size: 'md',
  },
});

export type StatusIconVariants = NonNullable<RecipeVariants<typeof statusIcon>>;

export const icon = recipe({
  base: {
    '@layer': {
      recipes: {
        display: 'block',
        color: 'currentColor',
      },
    },
  },
  variants: {
    size: {
      sm: {
        '@layer': {
          recipes: {
            width: '0.75rem',
            height: '0.75rem',
          },
        },
      },
      md: {
        '@layer': {
          recipes: {
            width: '0.875rem',
            height: '0.875rem',
          },
        },
      },
      lg: {
        '@layer': {
          recipes: {
            width: '1.25rem',
            height: '1.25rem',
          },
        },
      },
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

export type StatusIconIconVariants = NonNullable<RecipeVariants<typeof icon>>;
