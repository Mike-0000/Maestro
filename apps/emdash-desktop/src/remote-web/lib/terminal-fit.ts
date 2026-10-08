export type TerminalGrid = { cols: number; rows: number };

export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 28;
/** Largest size the automatic fit grows to; a narrow host terminal should not become a poster. */
export const MAX_FIT_FONT_SIZE = 14;
const FONT_STEP = 0.25;

export function clampFontSize(size: number, max = MAX_FONT_SIZE): number {
  if (!Number.isFinite(size)) return MIN_FONT_SIZE;
  return Math.min(max, Math.max(MIN_FONT_SIZE, size));
}

/**
 * The largest font size at which `cols` columns fit in `availableWidth`. `cellWidthRatio` is a
 * cell's width per pixel of font size (about 0.6 for a monospace face), measured from the live
 * terminal. Rounded down to a quarter pixel so rounding never pushes the last column off screen.
 */
export function fitFontSize(args: {
  availableWidth: number;
  cols: number;
  cellWidthRatio: number;
  max?: number;
}): number {
  const { availableWidth, cols, cellWidthRatio } = args;
  if (availableWidth <= 0 || cols <= 0 || cellWidthRatio <= 0) return MIN_FONT_SIZE;
  const exact = availableWidth / (cols * cellWidthRatio);
  const stepped = Math.floor(exact / FONT_STEP) * FONT_STEP;
  return clampFontSize(stepped, args.max ?? MAX_FIT_FONT_SIZE);
}

const MIN_COLS = 20;
const MIN_ROWS = 6;
const MAX_CELLS = 1000;

/** The grid that fills an area at a given cell size; what "Fit to this screen" asks the host for. */
export function gridForArea(args: {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
}): TerminalGrid {
  const cols = args.cellWidth > 0 ? Math.floor(args.width / args.cellWidth) : MIN_COLS;
  const rows = args.cellHeight > 0 ? Math.floor(args.height / args.cellHeight) : MIN_ROWS;
  return {
    cols: Math.min(MAX_CELLS, Math.max(MIN_COLS, cols)),
    rows: Math.min(MAX_CELLS, Math.max(MIN_ROWS, rows)),
  };
}

/** Font size after a pinch that changed the distance between two fingers by `scale`. */
export function pinchFontSize(startSize: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return clampFontSize(startSize);
  return clampFontSize(Math.round((startSize * scale) / FONT_STEP) * FONT_STEP);
}
