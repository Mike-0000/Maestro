/**
 * Desk layout (Canvas Pro): how a desk fills the screen. A desk is not a frame on a board that
 * happens to be screen sized; it is a column of **pages**, each exactly the part of the screen a
 * desk may use, and the camera only ever shows one whole page at zoom 1.
 *
 * The rules, which `deskViolations` checks and the planner (`tileDesk` in `canvas-layout.ts`)
 * keeps after every change:
 *
 * 1. **Fill.** The windows of a page cover it edge to edge, apart from the gap between panes.
 * 2. **No overfill.** A page takes only as many windows as fit at their comfortable size. The
 *    rest go to the next page; panes are never shrunk below that size to squeeze one more in.
 * 3. **Always tiled.** A desk has no free arrangement and no size of its own, and neither has a
 *    region on it. Dragging, nudging, and resizing change the order and the shares, never the
 *    fact that the desk is full.
 * 4. **A page is a screen.** Pages sit one screen apart, so the page in view is framed at zoom 1
 *    and its neighbours are off screen.
 *
 * A desk is still an ordinary region to everything else: its rect holds its members with the
 * usual region insets, so the classic canvas shows it as a valid tiled region. The header band
 * those insets reserve is simply above the page, out of view.
 *
 * Pure.
 */

import { FRAME_PADDING, type TileRect } from './canvas-model';
import {
  childRegions,
  COLLAPSED_REGION_HEIGHT,
  descendantRegions,
  descendantTiles,
  isFoldedAway,
  isRegionId,
  parentOf,
  REGION_HEADER,
  REGION_PADDING,
  windowKindOf,
  type LayoutState,
} from './canvas-regions';
import { placePanes, tilingTree, workspaceSize, type TilingItem } from './region-tiling';
import type { Box, SplitNode, StagePane } from './stage-layout';

/** Screen space a desk page leaves free: the toolbar above, a hair of backdrop around. */
export const DESK_INSETS = { top: 56, right: 8, bottom: 8, left: 8 } as const;
/** Space between panes on a desk (the Stage's gap). */
export const DESK_GAP = 8;
/** Most windows on one page, whatever the screen. */
export const DESK_PAGE_CAP = 12;

/**
 * A region's own chrome between its edge and its members: what `regionInsets` reserves before
 * task frames. On a desk this band is outside the page.
 */
const CHROME = {
  top: REGION_HEADER + REGION_PADDING / 2,
  side: REGION_PADDING,
  bottom: REGION_PADDING,
} as const;

export type DeskScreen = { readonly width: number; readonly height: number };

/**
 * The smallest pane a window is comfortable in on a desk. Larger than the size a window can be
 * dragged down to: it decides how many windows share a page, so it is the size at which an
 * agent's terminal is still worth reading. Every height is above the planner's reading-order row
 * band, so two rows of a page are never read as one.
 */
export function deskMinSize(tileId: string): { w: number; h: number } {
  switch (windowKindOf(tileId)) {
    case 'note':
      return { w: 220, h: 180 };
    case 'browser':
      return { w: 560, h: 360 };
    case 'doc':
      return { w: 420, h: 300 };
    default:
      return { w: 480, h: 280 };
  }
}

/** The size of a desk page: the screen less the desk insets. */
export function deskPageSize(screen: DeskScreen): { w: number; h: number } {
  return workspaceSize(screen, DESK_INSETS);
}

/** Distance from one page's top to the next: one screen. */
export function deskPitch(screen: DeskScreen): number {
  return deskPageSize(screen).h + DESK_INSETS.top + DESK_INSETS.bottom;
}

/** Space between panes: the desk gap, plus room for a task frame's header when frames show. */
export function deskGap(frameAllowance: number): number {
  return DESK_GAP + frameAllowance;
}

/** The rect of a desk with `pages` pages (its region chrome included). */
export function deskRectSize(screen: DeskScreen, pages: number): { w: number; h: number } {
  const page = deskPageSize(screen);
  return {
    w: page.w + CHROME.side * 2,
    h: CHROME.top + page.h + (Math.max(1, pages) - 1) * deskPitch(screen) + CHROME.bottom,
  };
}

/** How many pages a desk of this rect has on this screen (at least 1). */
export function deskPageCount(desk: TileRect, screen: DeskScreen): number {
  const single = deskRectSize(screen, 1);
  return Math.max(1, Math.round((desk.h - single.h) / deskPitch(screen)) + 1);
}

/** The part of the board page `page` of a desk covers: what the camera frames. */
export function deskPageBox(desk: TileRect, screen: DeskScreen, page: number): TileRect {
  const size = deskPageSize(screen);
  return {
    x: desk.x + CHROME.side,
    y: desk.y + CHROME.top + Math.max(0, page) * deskPitch(screen),
    ...size,
  };
}

/** Where windows go on a page: the page, less the room task frames need around their tiles. */
export function deskTilesArea(page: TileRect, frameAllowance: number): TileRect {
  const pad = frameAllowance > 0 ? FRAME_PADDING : 0;
  return {
    x: page.x + pad,
    y: page.y + frameAllowance,
    w: Math.max(1, page.w - pad * 2),
    h: Math.max(1, page.h - frameAllowance - pad),
  };
}

/** The page of a desk a rect on it lies on (by its middle). */
export function deskPageOf(desk: TileRect, screen: DeskScreen, rect: TileRect): number {
  const offset = rect.y + rect.h / 2 - (desk.y + CHROME.top);
  const page = Math.floor(offset / deskPitch(screen));
  return Math.min(deskPageCount(desk, screen) - 1, Math.max(0, page));
}

// ── Trees with minimums ──────────────────────────────────────────────────────

type Mins = ReadonlyMap<string, { readonly w: number; readonly h: number }>;

/** The smallest area a tree can be laid out in with every pane at its minimum. */
export function treeMinSize(tree: SplitNode | null, mins: Mins, gap: number): Size {
  if (!tree) return { w: 0, h: 0 };
  if (tree.type === 'leaf') return mins.get(tree.tileId) ?? { w: 0, h: 0 };
  const children = tree.children.map((child) => treeMinSize(child, mins, gap));
  const gaps = gap * (children.length - 1);
  const sum = (pick: (size: Size) => number) =>
    children.reduce((total, size) => total + pick(size), 0);
  const max = (pick: (size: Size) => number) => Math.max(0, ...children.map(pick));
  return tree.axis === 'row'
    ? { w: sum((size) => size.w) + gaps, h: max((size) => size.h) }
    : { w: max((size) => size.w), h: sum((size) => size.h) + gaps };
}

type Size = { readonly w: number; readonly h: number };

/**
 * Shares `usable` among children by ratio, but never gives one less than its minimum: a child
 * that would fall short takes its minimum and the others share what is left. When the minimums
 * do not fit at all, the plain ratios stand.
 */
export function shareWithMinimums(
  usable: number,
  ratios: readonly number[],
  mins: readonly number[]
): number[] {
  const total = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
  const needed = mins.reduce((sum, min) => sum + min, 0);
  if (needed > usable + 0.5) return ratios.map((ratio) => (usable * ratio) / total);
  const held = ratios.map(() => false);
  for (let pass = 0; pass < ratios.length; pass++) {
    let free = 0;
    let left = usable;
    ratios.forEach((ratio, index) => {
      if (held[index]) left -= mins[index] ?? 0;
      else free += ratio;
    });
    let changed = false;
    ratios.forEach((ratio, index) => {
      if (held[index] || free <= 0) return;
      if ((left * ratio) / free < (mins[index] ?? 0) - 1e-6) {
        held[index] = true;
        changed = true;
      }
    });
    if (!changed) {
      return ratios.map((ratio, index) =>
        held[index] ? (mins[index] ?? 0) : free > 0 ? (left * ratio) / free : 0
      );
    }
  }
  return mins.map((min) => min);
}

/**
 * Pane rects of a tree in `area`, by ratio but with no pane under its minimum whenever the tree
 * fits the area at all (`treeMinSize`). This is what lets "make Atlas much bigger" grow one pane
 * without starving its neighbours.
 */
export function layoutTreeWithin(
  tree: SplitNode | null,
  area: Box,
  gap: number,
  mins: Mins
): StagePane[] {
  const panes: StagePane[] = [];
  const visit = (node: SplitNode, box: Box) => {
    if (node.type === 'leaf') {
      panes.push({ tileId: node.tileId, rect: box, index: panes.length });
      return;
    }
    const row = node.axis === 'row';
    const usable = Math.max(0, (row ? box.w : box.h) - gap * (node.children.length - 1));
    const sizes = shareWithMinimums(
      usable,
      node.ratios,
      node.children.map((child) => {
        const min = treeMinSize(child, mins, gap);
        return row ? min.w : min.h;
      })
    );
    let offset = 0;
    node.children.forEach((child, index) => {
      const size = sizes[index] ?? 0;
      visit(
        child,
        row
          ? { x: box.x + offset, y: box.y, w: size, h: box.h }
          : { x: box.x, y: box.y + offset, w: box.w, h: size }
      );
      offset += size + gap;
    });
  };
  if (tree) visit(tree, area);
  return panes;
}

// ── Pages ────────────────────────────────────────────────────────────────────

function aspectOf(size: Size): number {
  return size.h > 0 ? size.w / size.h : 16 / 9;
}

/**
 * The split tree of one page: the region tiling's, except that with three windows the **first**
 * takes the main pane rather than the heaviest. A desk's order is what the user sets by dragging
 * and swapping, so the main pane goes to whoever they put first; and reading a page back gives
 * the order it was laid out from, which is what makes laying it out again change nothing.
 */
export function deskTree(items: readonly TilingItem[], aspect: number): SplitNode | null {
  const [main, second, third] = items;
  if (items.length !== 3 || !main || !second || !third) return tilingTree(items, aspect);
  const landscape = aspect >= 1;
  const rest = (second.weight + third.weight) / 2;
  const total = main.weight + rest || 1;
  return {
    type: 'split',
    axis: landscape ? 'row' : 'column',
    ratios: [main.weight / total, rest / total],
    children: [
      { type: 'leaf', tileId: main.id },
      // The other two stack beside a main pane on the left, or sit side by side under one on top.
      tilingTree([second, third], landscape ? 0.5 : 2) as SplitNode,
    ],
  };
}

/** True when `items` tile into `size` with every pane at or above its minimum. */
export function fitsPage(items: readonly TilingItem[], size: Size, gap: number): boolean {
  const mins = new Map(items.map((item) => [item.id, item.min]));
  const needed = treeMinSize(deskTree(items, aspectOf(size)), mins, gap);
  return needed.w <= size.w + 0.5 && needed.h <= size.h + 0.5;
}

/**
 * Splits `items` (in reading order) into pages: each page takes as many as fit at their minimums,
 * up to the cap, and always at least one (a window too big for the screen still gets a page).
 * Earlier pages are full before a later one starts, so a new window never reshuffles them.
 */
export function paginateDesk(
  items: readonly TilingItem[],
  sizeOf: (page: number) => Size,
  gap: number
): TilingItem[][] {
  const pages: TilingItem[][] = [];
  let start = 0;
  while (start < items.length) {
    const size = sizeOf(pages.length);
    let take = 1;
    for (let count = Math.min(items.length - start, DESK_PAGE_CAP); count > 1; count--) {
      if (fitsPage(items.slice(start, start + count), size, gap)) {
        take = count;
        break;
      }
    }
    pages.push(items.slice(start, start + take));
    start += take;
  }
  return pages;
}

export type DeskPlan = {
  /** The desk's rect size, region chrome included. */
  readonly size: Size;
  readonly pages: number;
  /** Member rects relative to the desk's top-left. */
  readonly panes: ReadonlyMap<string, TileRect>;
  /** Where the strip of folded regions starts, relative to the desk's top-left. */
  readonly strip: { readonly x: number; readonly y: number };
};

/**
 * Lays a desk out: `items` in reading order, paged and tiled so every page is full. `stripHeight`
 * is the room folded child regions take along the top of the first page (0 when there are none).
 */
export function planDesk(input: {
  readonly items: readonly TilingItem[];
  readonly screen: DeskScreen;
  readonly frameAllowance: number;
  readonly stripHeight?: number;
}): DeskPlan {
  const { items, screen, frameAllowance } = input;
  const gap = deskGap(frameAllowance);
  const stripHeight = input.stripHeight ?? 0;
  const origin = { x: 0, y: 0, w: 0, h: 0 };
  const areaOf = (page: number): TileRect => {
    const area = deskTilesArea(deskPageBox(origin, screen, page), frameAllowance);
    if (page > 0 || stripHeight <= 0) return area;
    // Folded regions keep a strip along the top of the first page.
    const taken = Math.min(stripHeight, area.h - 1);
    return { ...area, y: area.y + taken, h: area.h - taken };
  };
  const pages = paginateDesk(items, areaOf, gap);
  const panes = new Map<string, TileRect>();
  pages.forEach((pageItems, page) => {
    const area = areaOf(page);
    const mins = new Map(pageItems.map((item) => [item.id, item.min]));
    const laid = layoutTreeWithin(
      deskTree(pageItems, aspectOf(area)),
      { x: 0, y: 0, w: area.w, h: area.h },
      gap,
      mins
    );
    for (const [id, rect] of placePanes(laid, area)) panes.set(id, rect);
  });
  const count = Math.max(1, pages.length);
  const first = deskTilesArea(deskPageBox(origin, screen, 0), frameAllowance);
  return {
    size: deskRectSize(screen, count),
    pages: count,
    panes,
    strip: { x: first.x, y: first.y },
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type DeskViolation =
  | 'not-a-desk'
  | 'not-tiled'
  | 'user-sized'
  | 'wrong-size'
  | 'outside-page'
  | 'empty-page'
  | 'overlap'
  | 'unfilled'
  | 'overfilled';

export type DeskCheck = {
  readonly screen: DeskScreen;
  readonly frameAllowance: number;
  /** Windows that exist and are open (hidden ones take no space). */
  readonly present: ReadonlySet<string>;
};

/** Share of a page that may stay uncovered before it counts as unfilled (rounding only). */
const UNFILLED_TOLERANCE = 0.002;

/**
 * Every way a desk breaks the rules at the top of this file; empty when it holds them. It reads
 * only the geometry that is there, not how the planner would lay the desk out, so it also
 * catches a planner that gets it wrong. A folded desk is not laid out and is never in violation.
 */
export function deskViolations(
  state: LayoutState,
  deskId: string,
  check: DeskCheck
): DeskViolation[] {
  const desk = state.regions[deskId];
  if (!desk || parentOf(state, deskId) !== null) return ['not-a-desk'];
  if (desk.collapsed) return [];
  const found = new Set<DeskViolation>();
  // Everything on a desk is tiled, all the way down.
  const nested = descendantRegions(state, deskId);
  if ([deskId, ...nested].some((id) => state.regions[id]?.arrangement !== 'tiled')) {
    found.add('not-tiled');
  }
  if (desk.screenSized === false) found.add('user-sized');

  const { screen, frameAllowance } = check;
  const pages = deskPageCount(desk.rect, screen);
  const expected = deskRectSize(screen, pages);
  if (Math.abs(desk.rect.w - expected.w) > 1 || Math.abs(desk.rect.h - expected.h) > 1) {
    found.add('wrong-size');
  }

  const hidden = new Set(state.hidden);
  const regions = childRegions(state, deskId);
  const folded = regions.filter((id) => state.regions[id]?.collapsed);
  const members: { id: string; rect: TileRect }[] = [
    ...[...check.present]
      .filter((id) => !isRegionId(id) && !hidden.has(id) && parentOf(state, id) === deskId)
      .flatMap((id) => {
        const rect = state.tiles[id];
        return rect ? [{ id, rect }] : [];
      }),
    ...regions
      .filter((id) => !state.regions[id]?.collapsed)
      .map((id) => ({ id, rect: (state.regions[id] as { rect: TileRect }).rect })),
  ];
  const gap = deskGap(frameAllowance);
  const byPage = new Map<number, { id: string; rect: TileRect }[]>();
  for (const member of members) {
    const page = deskPageOf(desk.rect, screen, member.rect);
    byPage.set(page, [...(byPage.get(page) ?? []), member]);
  }
  for (let page = 0; page < pages; page++) {
    const here = byPage.get(page) ?? [];
    if (here.length === 0) {
      if (members.length > 0 || pages > 1) found.add('empty-page');
      continue;
    }
    let area = deskTilesArea(deskPageBox(desk.rect, screen, page), frameAllowance);
    if (page === 0 && folded.length > 0) {
      const taken = Math.min(COLLAPSED_REGION_HEIGHT + gap, area.h - 1);
      area = { ...area, y: area.y + taken, h: area.h - taken };
    }
    if (here.some(({ rect }) => !inside(rect, area, 1))) found.add('outside-page');
    if (here.some((a, i) => here.some((b, j) => j > i && overlaps(a.rect, b.rect)))) {
      found.add('overlap');
    }
    const covered = here.map(({ rect }) => inflate(rect, gap / 2 + 0.5));
    if (uncovered(area, covered) > area.w * area.h * UNFILLED_TOLERANCE) found.add('unfilled');
    if (
      here.length > 1 &&
      here.some(({ id, rect }) => {
        if (isRegionId(id)) return false;
        const min = deskMinSize(id);
        return rect.w < min.w - 1 || rect.h < min.h - 1;
      })
    ) {
      found.add('overfilled');
    }
  }
  // Nothing on a desk, however deeply grouped, reaches past its page.
  for (const id of descendantTiles(state, deskId)) {
    const rect = state.tiles[id];
    if (!rect || !check.present.has(id) || hidden.has(id) || isFoldedAway(state, id)) continue;
    const page = deskPageBox(desk.rect, screen, deskPageOf(desk.rect, screen, rect));
    if (!inside(rect, page, 1)) found.add('outside-page');
  }
  return [...found];
}

function inside(rect: TileRect, area: TileRect, slack: number): boolean {
  return (
    rect.x >= area.x - slack &&
    rect.y >= area.y - slack &&
    rect.x + rect.w <= area.x + area.w + slack &&
    rect.y + rect.h <= area.y + area.h + slack
  );
}

function overlaps(a: TileRect, b: TileRect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5
  );
}

function inflate(rect: TileRect, by: number): TileRect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/** The part of `area` (in px²) no rect covers. */
function uncovered(area: TileRect, rects: readonly TileRect[]): number {
  const clip = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  const xs = [
    ...new Set(
      [area.x, right, ...rects.flatMap((r) => [r.x, r.x + r.w])].map((x) => clip(x, area.x, right))
    ),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set(
      [area.y, bottom, ...rects.flatMap((r) => [r.y, r.y + r.h])].map((y) =>
        clip(y, area.y, bottom)
      )
    ),
  ].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = ((xs[i] as number) + (xs[i + 1] as number)) / 2;
      const cy = ((ys[j] as number) + (ys[j + 1] as number)) / 2;
      const hit = rects.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
      if (!hit) {
        total +=
          ((xs[i + 1] as number) - (xs[i] as number)) * ((ys[j + 1] as number) - (ys[j] as number));
      }
    }
  }
  return total;
}
