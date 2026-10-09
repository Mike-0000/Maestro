/**
 * Multi-canvas: several views of the one board side by side, each with its own camera. Pure.
 *
 * The views share every window; a window that shows in more than one view is live in exactly one
 * of them (a terminal or a webview cannot be mounted twice).
 */

import { rectsOverlap, type CanvasViewport, type TileRect } from './canvas-model';

export const MAX_PANES = 4;
/** Width of the line between two views, in CSS px. */
export const PANE_DIVIDER = 1;

export type PaneView = {
  readonly viewport: CanvasViewport;
  /** The sub-canvas this view is in (each view remembers its own). */
  readonly regionScope: string | null;
};

export function clampPaneCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.min(MAX_PANES, Math.max(1, Math.round(count)));
}

/** The split for a number of views: two and three sit side by side, four make quadrants. */
export function paneGrid(count: number): { columns: number; rows: number } {
  const panes = clampPaneCount(count);
  return panes === 4 ? { columns: 2, rows: 2 } : { columns: panes, rows: 1 };
}

/** Where each view sits in a surface of `surface` px (row by row), dividers left between them. */
export function paneBoxes(
  count: number,
  surface: { width: number; height: number },
  divider = PANE_DIVIDER
): TileRect[] {
  const { columns, rows } = paneGrid(count);
  const w = Math.max(0, (surface.width - divider * (columns - 1)) / columns);
  const h = Math.max(0, (surface.height - divider * (rows - 1)) / rows);
  const boxes: TileRect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      boxes.push({ x: column * (w + divider), y: row * (h + divider), w, h });
    }
  }
  return boxes;
}

/**
 * Cameras that continue one picture across `boxes`: each view shows the part of `viewport` that
 * lies under it, so splitting the canvas changes nothing on screen but the dividers.
 */
export function splitViewport(
  viewport: CanvasViewport,
  boxes: readonly TileRect[]
): CanvasViewport[] {
  return boxes.map((box) => ({
    x: viewport.x - box.x,
    y: viewport.y - box.y,
    zoom: viewport.zoom,
  }));
}

/**
 * The view a window is live in: the active view when the window shows there, else the first view
 * it shows in, else the active view.
 */
export function livePane(rect: TileRect, views: readonly TileRect[], active: number): number {
  const activeView = views[active];
  if (activeView && rectsOverlap(rect, activeView)) return active;
  const first = views.findIndex((view) => rectsOverlap(rect, view));
  return first === -1 ? active : first;
}
