import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { labelBase } from '../label/label.css';
import { vars } from '@theme/core/contract/contract.css';
import { tokenVars } from '@theme/tokens.css';

export const field = recipe({
  base: {
    display: 'flex',
    gap: '0.375rem',
    width: '100%',
  },
  variants: {
    orientation: {
      vertical: {
        flexDirection: 'column',
      },
      // Label block left, control right. The row is a size container: when the
      // control and a readable label (12rem) no longer fit side by side the
      // control wraps under the label, and under `fieldStackWidth` the row
      // stacks (label over a left-aligned, full-width control slot).
      horizontal: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: '1rem',
        rowGap: '0.5rem',
        containerType: 'inline-size',
      },
    },
  },
  defaultVariants: {
    orientation: 'vertical',
  },
});

export type FieldVariants = NonNullable<RecipeVariants<typeof field>>;

/** Row width under which a horizontal field stacks its label over the control. */
const fieldStackWidth = '26rem';

// Label + description stacked, used in horizontal mode to occupy the left side.
export const fieldContent = style({
  display: 'flex',
  flexDirection: 'column',
  // Grows to fill the row; never squeezed below a readable 12rem beside the
  // control (the control wraps instead).
  flex: '1 1 12rem',
  gap: '0.25rem',
  minWidth: 0,
  '@container': {
    [`(max-width: ${fieldStackWidth})`]: { flexBasis: '100%' },
  },
});

// The control on the right side of a horizontal field row. It sizes to its
// control (switches hug right; selects and inputs bring their width: w-56 /
// w-64, design brief 2.8), capped at 16rem; callers override via className.
// marginLeft:auto pushes the slot to the right edge even when FieldContent is
// absent. In a stacked (narrow) row it starts under the label at full width.
export const fieldControlSlot = style({
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  marginLeft: 'auto',
  flex: '0 1 auto',
  minWidth: 0,
  maxWidth: '16rem',
  '@container': {
    [`(max-width: ${fieldStackWidth})`]: {
      marginLeft: 0,
      justifyContent: 'flex-start',
      width: '100%',
      maxWidth: '100%',
    },
  },
});

// Label typography is owned by the standalone Label primitive; Field.Label
// composes the same base so the two never drift.
export const fieldLabel = style([labelBase]);

// Helper text under a field: 12px muted.
export const fieldDescription = style({
  fontSize: tokenVars.textXs,
  color: vars.foregroundMuted,
  lineHeight: tokenVars.textXsLineHeight,
});

// Validation message: 12px in the error tone, no red box (brief 2.8).
export const fieldError = style({
  fontSize: tokenVars.textXs,
  lineHeight: tokenVars.textXsLineHeight,
  color: vars.foregroundError,
});

// A semantic grouping of related fields (renders a <fieldset>).
export const fieldSet = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
  minWidth: 0,
  margin: 0,
  padding: 0,
  border: 0,
});

export const fieldLegend = recipe({
  base: {
    marginBottom: '0.75rem',
    padding: 0,
    fontWeight: 600,
    color: vars.foreground,
  },
  variants: {
    variant: {
      legend: { fontSize: tokenVars.textBase },
      label: { fontSize: tokenVars.textSm },
    },
  },
  defaultVariants: { variant: 'legend' },
});

export type FieldLegendVariants = NonNullable<RecipeVariants<typeof fieldLegend>>;

// Vertical stack of Field rows with consistent spacing.
export const fieldGroup = style({
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  gap: '1.25rem',
});
