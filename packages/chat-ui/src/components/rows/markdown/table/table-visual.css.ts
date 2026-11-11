/**
 * table-visual.css.ts — visual styles for Table.tsx cells.
 *
 * Geometry rules (font-size, line-height, cell padding) stay in table.css.ts.
 * This file covers scrolling, borders, and background decoration.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { TABLE_BORDER, TABLE_SCROLLBAR_SIZE } from './geometry';
import { vars } from '@styles/theme.css';

/**
 * Scroll wrapper around the table. Tables read as text, not as a grid of boxes:
 * one hairline frame (it explains the cells' inset), no column rules, a firmer
 * rule under the header and a hairline between rows. Every edge keeps its
 * measured width (TABLE_BORDER) and only chooses whether it draws, so row
 * heights do not move.
 */
export const tableScroll = style({
  border: `${TABLE_BORDER}px solid ${vars.borderSubtle}`,
  borderRadius: vars.radiusMd,
  width: '100%',
  height: '100%',
  overflowX: 'auto',
  overflowY: 'hidden',
  boxSizing: 'border-box',
  scrollbarWidth: 'thin',
});

globalStyle(`${tableScroll}::-webkit-scrollbar`, {
  height: `${TABLE_SCROLLBAR_SIZE}px`,
});

/** Applied to <th> cells: full-strength headline text over the one firmer rule. */
export const thCell = style({
  background: vars.tableHeaderBg,
  color: vars.fg,
  whiteSpace: 'nowrap',
  // No column rules. Column widths budget TABLE_BORDER for one, so dropping it
  // only gives the cell a pixel more room; the row rules then join unbroken.
  borderRight: 'none',
  borderBottom: `${TABLE_BORDER}px solid ${vars.border}`,
});

/** Applied to <td> cells: body text, a hairline between rows. */
export const tdCell = style({
  color: vars.fgBody,
  whiteSpace: 'nowrap',
  borderRight: 'none',
  borderBottom: `${TABLE_BORDER}px solid ${vars.borderSubtle}`,
});

/** Remove bottom border from the last row's td cells. */
export const tdCellLastRow = style({
  borderBottom: 'none',
});
