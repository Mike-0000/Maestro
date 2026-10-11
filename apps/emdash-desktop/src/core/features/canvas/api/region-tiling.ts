/**
 * Region tiling: a sub-canvas lays its members out as a weighted split of its whole content area,
 * so four windows become quadrants and an app browser gets more room than the agent next to it.
 * A top-level tiled region is sized like the canvas viewport, so framing it lands at zoom 1 and
 * it reads as a separate, full-screen workspace. Also the pure rules for being "in" a region:
 * when the camera has left it, and how a focused region's windows are promoted to full rendering.
 * Pure.
 */

import type { TileRect } from './canvas-model';
import {
  childRegions,
  descendantTiles,
  isFoldedAway,
  parentOf,
  type LayoutState,
} from './canvas-regions';
import { layoutTree, type Box, type SplitNode, type StagePane } from './stage-layout';

export type TilingItem = {
  readonly id: string;
  /** Relative share of the area; pane area is proportional to it. */
  readonly weight: number;
  /** Smallest pane the item accepts. */
  readonly min: { readonly w: number; readonly h: number };
};

/** Screen space a framed workspace leaves around the region (the toolbar sits at the top). */
export const WORKSPACE_INSETS = { top: 56, right: 16, bottom: 16, left: 16 } as const;
/** Used when the canvas has not measured itself yet (tests, first paint). */
export const FALLBACK_SCREEN = { width: 1600, height: 900 } as const;
/** Bounds of a user's size adjustment in a tiled region ("make the browser larger"). */
export const MIN_TILE_WEIGHT = 0.25;
export const MAX_TILE_WEIGHT = 6;
/** Each "bigger" / "smaller" step in a tiled region scales the window's weight by this. */
export const WEIGHT_STEP = 1.5;

/** Default share by window kind: an app browser gets more room than an agent, a note less. */
export function baseTileWeight(id: string): number {
  if (id.startsWith('browser:')) return 1.5;
  if (id.startsWith('note:')) return 0.5;
  return 1;
}

export function clampWeight(weight: number): number {
  return Math.min(MAX_TILE_WEIGHT, Math.max(MIN_TILE_WEIGHT, weight));
}

/** The region size that fills the canvas at zoom 1, leaving `insets` (the workspace's by default). */
export function workspaceSize(
  screen: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number } = WORKSPACE_INSETS
): {
  w: number;
  h: number;
} {
  const width = screen.width > 0 ? screen.width : FALLBACK_SCREEN.width;
  const height = screen.height > 0 ? screen.height : FALLBACK_SCREEN.height;
  return {
    w: Math.max(320, Math.round(width - insets.left - insets.right)),
    h: Math.max(160, Math.round(height - insets.top - insets.bottom)),
  };
}

// ── Trees ────────────────────────────────────────────────────────────────────

const leaf = (item: TilingItem): SplitNode => ({ type: 'leaf', tileId: item.id });

function line(items: readonly TilingItem[], axis: 'row' | 'column'): SplitNode {
  if (items.length === 1) return leaf(items[0] as TilingItem);
  return {
    type: 'split',
    axis,
    ratios: normalized(items.map((item) => item.weight)),
    children: items.map(leaf),
  };
}

function normalized(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return weights.map((weight) => weight / total);
}

function sum(items: readonly TilingItem[]): number {
  return items.reduce((total, item) => total + item.weight, 0);
}

/** Columns per row for `count` windows in an area of `aspect` (w/h). */
export function tilingColumns(count: number, aspect: number): number {
  if (count <= 2) return count;
  if (count <= 4) return 2;
  if (count <= 6) return aspect >= 1 ? 3 : 2;
  if (count <= 9) return 3;
  return Math.ceil(Math.sqrt(count * Math.max(1, aspect / 1.6)));
}

/**
 * The split tree for `items` (in reading order) in an area of `aspect` (w/h):
 * 2 side by side (stacked when portrait), 3 as a main pane for the heaviest plus two, 4 as
 * quadrants, more as balanced rows. Row heights follow the rows' total weight and panes in a row
 * follow their own, so every pane's area is proportional to its weight.
 */
export function tilingTree(items: readonly TilingItem[], aspect: number): SplitNode | null {
  const n = items.length;
  if (n === 0) return null;
  if (n === 1) return leaf(items[0] as TilingItem);
  const landscape = aspect >= 1;
  if (n === 2) return line(items, landscape ? 'row' : 'column');
  if (n === 3) {
    let main = 0;
    items.forEach((item, index) => {
      if (item.weight > (items[main] as TilingItem).weight) main = index;
    });
    const mainItem = items[main] as TilingItem;
    const rest = items.filter((_, index) => index !== main);
    const restMean = sum(rest) / rest.length;
    return {
      type: 'split',
      axis: landscape ? 'row' : 'column',
      ratios: normalized([mainItem.weight, restMean]),
      children: [leaf(mainItem), line(rest, landscape ? 'column' : 'row')],
    };
  }
  const columns = tilingColumns(n, aspect);
  const rows: TilingItem[][] = [];
  for (let start = 0; start < n; start += columns) rows.push(items.slice(start, start + columns));
  return {
    type: 'split',
    axis: 'column',
    ratios: normalized(rows.map(sum)),
    children: rows.map((row) => line(row, 'row')),
  };
}

export type Tiling = {
  /** The content area actually used (at least the requested size). */
  readonly area: { readonly w: number; readonly h: number };
  readonly tree: SplitNode | null;
  /** Pane rects relative to the area's top-left. */
  readonly panes: readonly StagePane[];
};

function fits(panes: readonly StagePane[], mins: ReadonlyMap<string, TilingItem['min']>): boolean {
  return panes.every((pane) => {
    const min = mins.get(pane.tileId);
    return !min || (pane.rect.w + 0.5 >= min.w && pane.rect.h + 0.5 >= min.h);
  });
}

/**
 * Tiles `items` into an area of `size`, growing the area uniformly (keeping its shape) until every
 * pane meets its item's minimum. Never shrinks: extra room is shared, not wasted.
 */
export function planTiling(
  items: readonly TilingItem[],
  size: { w: number; h: number },
  gap: number
): Tiling {
  const aspect = size.h > 0 ? size.w / size.h : 16 / 9;
  const tree = tilingTree(items, aspect);
  const mins = new Map(items.map((item) => [item.id, item.min]));
  let w = Math.max(1, size.w);
  let h = Math.max(1, size.h);
  let panes = layoutTree(tree, { x: 0, y: 0, w, h }, gap);
  for (let attempt = 0; attempt < 16 && !fits(panes, mins); attempt++) {
    const needed = Math.max(
      ...panes.map((pane) => {
        const min = mins.get(pane.tileId);
        if (!min) return 1;
        return Math.max(min.w / Math.max(1, pane.rect.w), min.h / Math.max(1, pane.rect.h));
      })
    );
    const k = Math.max(1.05, needed);
    w = Math.ceil(w * k);
    h = Math.ceil(h * k);
    panes = layoutTree(tree, { x: 0, y: 0, w, h }, gap);
  }
  return { area: { w, h }, tree, panes };
}

/** Pane rects placed at `origin`, rounded to whole pixels without gaps opening between panes. */
export function placePanes(
  panes: readonly StagePane[],
  origin: { x: number; y: number }
): Map<string, TileRect> {
  const out = new Map<string, TileRect>();
  for (const pane of panes) {
    const x = Math.round(origin.x + pane.rect.x);
    const y = Math.round(origin.y + pane.rect.y);
    const right = Math.round(origin.x + pane.rect.x + pane.rect.w);
    const bottom = Math.round(origin.y + pane.rect.y + pane.rect.h);
    out.set(pane.tileId, { x, y, w: right - x, h: bottom - y });
  }
  return out;
}

// ── Being in a region ────────────────────────────────────────────────────────

/** How the camera sees a region: the region's share on screen and the screen's share of it. */
export function regionCoverage(view: Box, region: Box): { visible: number; cover: number } {
  const w = Math.max(
    0,
    Math.min(view.x + view.w, region.x + region.w) - Math.max(view.x, region.x)
  );
  const h = Math.max(
    0,
    Math.min(view.y + view.h, region.y + region.h) - Math.max(view.y, region.y)
  );
  const overlap = w * h;
  const regionArea = Math.max(1, region.w * region.h);
  const viewArea = Math.max(1, view.w * view.h);
  return { visible: overlap / regionArea, cover: overlap / viewArea };
}

/**
 * True when the user has left a region they were in by moving the camera: they panned it mostly
 * off screen, or zoomed out to well under the zoom it was framed at while it became a small part
 * of the view. Small pans and zooms inside a workspace keep it.
 */
export function cameraLeftRegion(
  view: Box,
  region: Box,
  zoom?: { readonly current: number; readonly framed: number }
): boolean {
  const { visible, cover } = regionCoverage(view, region);
  if (visible < 0.3) return true;
  const zoomedOut = zoom
    ? zoom.current < zoom.framed * 0.5
    : view.w * view.h > 4 * region.w * region.h;
  return zoomedOut && cover < 0.25;
}

/**
 * The camera for framing `rect` on a screen: centered in the space the workspace insets leave,
 * as large as fits, never above zoom 1 (a workspace-sized region lands exactly at 1, where
 * terminals take pointer input).
 */
export function frameViewport(
  rect: Box,
  screen: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number } = WORKSPACE_INSETS,
  maxZoom = 1
): { x: number; y: number; zoom: number } {
  const availableW = Math.max(1, screen.width - insets.left - insets.right);
  const availableH = Math.max(1, screen.height - insets.top - insets.bottom);
  let zoom = Math.min(maxZoom, availableW / Math.max(1, rect.w), availableH / Math.max(1, rect.h));
  // A hair under 1 (a resize in flight) still frames at 1 rather than blurring every terminal.
  if (zoom > 0.985 && zoom < 1 && maxZoom >= 1) zoom = 1;
  const x = insets.left + (availableW - rect.w * zoom) / 2 - rect.x * zoom;
  const y = insets.top + (availableH - rect.h * zoom) / 2 - rect.y * zoom;
  return { x, y, zoom };
}

// ── Render promotion ─────────────────────────────────────────────────────────

/**
 * Cap on windows promoted at once. Promotion keeps a focused region's app browsers mounted; agent
 * tiles are always live and do not use it.
 */
export const PROMOTED_LIVE_CAP = 12;

/**
 * The windows of a focused region that stay promoted: every shown window anywhere under it (not
 * hidden, not inside a folded child), most recently focused first, up to `cap`.
 */
export function promotedTiles(
  state: LayoutState,
  regionId: string | null,
  visible: ReadonlySet<string>,
  rank: (tileId: string) => number,
  cap: number = PROMOTED_LIVE_CAP
): string[] {
  if (!regionId || !state.regions[regionId] || state.regions[regionId]?.collapsed) return [];
  const hidden = new Set(state.hidden);
  return descendantTiles(state, regionId)
    .filter((id) => visible.has(id) && !hidden.has(id) && !isFoldedAway(state, id))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, cap);
}

// ── Moving between regions ───────────────────────────────────────────────────

/** Regions at the same level as `regionId` (the root's regions for null), in reading order. */
export function peerRegions(state: LayoutState, regionId: string | null): string[] {
  const parent = regionId ? parentOf(state, regionId) : null;
  const peers = childRegions(state, parent);
  return peers.sort((a, b) => {
    const ra = state.regions[a]?.rect;
    const rb = state.regions[b]?.rect;
    if (!ra || !rb) return a.localeCompare(b);
    // Same band when their tops are within half the shorter one's height.
    const band = Math.min(ra.h, rb.h) / 2;
    return Math.abs(ra.y - rb.y) > band ? ra.y - rb.y : ra.x - rb.x || a.localeCompare(b);
  });
}

/**
 * The next (step 1) or previous (step -1) region beside `regionId`, wrapping; from the board root
 * the first or last top-level region. Null when there is nowhere else to go.
 */
export function adjacentRegion(
  state: LayoutState,
  regionId: string | null,
  step: 1 | -1
): string | null {
  const peers = peerRegions(state, regionId);
  if (peers.length === 0) return null;
  if (!regionId) return (step === 1 ? peers[0] : peers.at(-1)) ?? null;
  const index = peers.indexOf(regionId);
  if (index === -1 || peers.length === 1) return null;
  return peers[(index + step + peers.length) % peers.length] ?? null;
}
