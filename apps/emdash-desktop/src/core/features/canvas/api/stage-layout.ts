/**
 * Stage layouts: a full-screen, zoom-1 tiling of a set of windows as a split tree. Trees are
 * generated from templates (by count, window weights, and screen aspect), paginate when panes
 * would drop below a window kind's minimum size, and keep user-adjusted ratios while the set of
 * windows on a page is unchanged. Pure.
 */

import { minSizeOf, windowKindOf } from './canvas-regions';

export type SplitNode =
  | { readonly type: 'leaf'; readonly tileId: string }
  | {
      readonly type: 'split';
      /** `row`: children side by side; `column`: children stacked. */
      readonly axis: 'row' | 'column';
      readonly ratios: readonly number[];
      readonly children: readonly SplitNode[];
    };

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type StagePane = { readonly tileId: string; readonly rect: Box; readonly index: number };

/** A splitter between two children of a split: drag it to change their ratio. */
export type StageSplitter = {
  readonly path: readonly number[];
  /** The splitter sits after child `index`. */
  readonly index: number;
  readonly axis: 'row' | 'column';
  readonly rect: Box;
  /** Size of the split along its axis, for converting drag pixels to ratio. */
  readonly span: number;
};

export const STAGE_GAP = 8;
const PAGE_SIZES = [9, 6, 4, 3, 2, 1] as const;
/** Smallest share a pane may shrink to when ratios are edited. */
const MIN_RATIO = 0.12;

export function stageWeight(tileId: string): number {
  switch (windowKindOf(tileId)) {
    case 'browser':
      return 1.5;
    case 'note':
      return 0.5;
    default:
      return 1;
  }
}

const leaf = (tileId: string): SplitNode => ({ type: 'leaf', tileId });

function weighted(tileIds: readonly string[]): number[] {
  const weights = tileIds.map(stageWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function even(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function row(tileIds: readonly string[]): SplitNode {
  if (tileIds.length === 1) return leaf(tileIds[0] as string);
  return { type: 'split', axis: 'row', ratios: weighted(tileIds), children: tileIds.map(leaf) };
}

function column(tileIds: readonly string[]): SplitNode {
  if (tileIds.length === 1) return leaf(tileIds[0] as string);
  return { type: 'split', axis: 'column', ratios: weighted(tileIds), children: tileIds.map(leaf) };
}

function rows(groups: readonly (readonly string[])[]): SplitNode {
  const children = groups.filter((group) => group.length > 0).map(row);
  if (children.length === 1) return children[0] as SplitNode;
  return { type: 'split', axis: 'column', ratios: even(children.length), children };
}

/** The template tree for `tileIds` (in pane order) in an area of `aspect` (w/h). */
export function templateTree(tileIds: readonly string[], aspect: number): SplitNode | null {
  const n = tileIds.length;
  if (n === 0) return null;
  const landscape = aspect >= 1.3;
  const [a, b, c] = tileIds as string[];
  if (n === 1) return leaf(a as string);
  if (n === 2) return landscape ? row(tileIds) : column(tileIds);
  if (n === 3) {
    const main = leaf(a as string);
    const rest = landscape ? column([b as string, c as string]) : row([b as string, c as string]);
    return {
      type: 'split',
      axis: landscape ? 'row' : 'column',
      ratios: landscape ? [0.6, 0.4] : [0.55, 0.45],
      children: [main, rest],
    };
  }
  if (n === 4) return rows([tileIds.slice(0, 2), tileIds.slice(2)]);
  if (n <= 6) {
    return landscape
      ? rows([tileIds.slice(0, 3), tileIds.slice(3)])
      : rows([tileIds.slice(0, 2), tileIds.slice(2, 4), tileIds.slice(4)]);
  }
  return rows([tileIds.slice(0, 3), tileIds.slice(3, 6), tileIds.slice(6, 9)]);
}

/** Pane rects of a tree laid out in `area`. */
export function layoutTree(tree: SplitNode | null, area: Box, gap = STAGE_GAP): StagePane[] {
  const panes: StagePane[] = [];
  const visit = (node: SplitNode, box: Box) => {
    if (node.type === 'leaf') {
      panes.push({ tileId: node.tileId, rect: box, index: panes.length });
      return;
    }
    for (const [index, child] of node.children.entries()) {
      visit(child, childBox(node, box, index, gap));
    }
  };
  if (tree) visit(tree, area);
  return panes;
}

function childBox(
  node: Extract<SplitNode, { type: 'split' }>,
  box: Box,
  index: number,
  gap: number
): Box {
  const count = node.children.length;
  const along = node.axis === 'row' ? box.w : box.h;
  const usable = Math.max(0, along - gap * (count - 1));
  const total = node.ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += (usable * (node.ratios[i] ?? 0)) / total + gap;
  const size = (usable * (node.ratios[index] ?? 0)) / total;
  return node.axis === 'row'
    ? { x: box.x + offset, y: box.y, w: size, h: box.h }
    : { x: box.x, y: box.y + offset, w: box.w, h: size };
}

/** Splitters of a tree laid out in `area`. */
export function treeSplitters(tree: SplitNode | null, area: Box, gap = STAGE_GAP): StageSplitter[] {
  const splitters: StageSplitter[] = [];
  const visit = (node: SplitNode, box: Box, path: number[]) => {
    if (node.type === 'leaf') return;
    const span = (node.axis === 'row' ? box.w : box.h) - gap * (node.children.length - 1);
    for (let index = 0; index < node.children.length; index++) {
      const child = childBox(node, box, index, gap);
      visit(node.children[index] as SplitNode, child, [...path, index]);
      if (index === node.children.length - 1) continue;
      splitters.push({
        path,
        index,
        axis: node.axis,
        span,
        rect:
          node.axis === 'row'
            ? { x: child.x + child.w, y: box.y, w: gap, h: box.h }
            : { x: box.x, y: child.y + child.h, w: box.w, h: gap },
      });
    }
  };
  if (tree) visit(tree, area, []);
  return splitters;
}

export function leafOrder(tree: SplitNode | null): string[] {
  if (!tree) return [];
  if (tree.type === 'leaf') return [tree.tileId];
  return tree.children.flatMap(leafOrder);
}

/** True when every pane in the tree is at least its window kind's minimum size. */
export function fitsMinimums(tree: SplitNode | null, area: Box): boolean {
  return layoutTree(tree, area).every((pane) => {
    const min = minSizeOf(pane.tileId);
    return pane.rect.w + 0.5 >= min.w && pane.rect.h + 0.5 >= min.h;
  });
}

/** How many windows fit on one page of this area (at least 1). */
export function pageSizeFor(tileIds: readonly string[], area: Box): number {
  const aspect = area.h > 0 ? area.w / area.h : 16 / 9;
  for (const size of PAGE_SIZES) {
    if (size > tileIds.length && size !== 1) continue;
    const sample = tileIds.slice(0, size);
    if (fitsMinimums(templateTree(sample, aspect), area)) return size;
  }
  return 1;
}

export type StageSaved = {
  /** Pane order the user chose ("put Bravo first"); unknown ids are ignored. */
  readonly order: readonly string[];
  /** Adjusted trees by the sorted set of tile ids on a page. */
  readonly trees: Readonly<Record<string, SplitNode>>;
  readonly soloTileId: string | null;
};

export const EMPTY_STAGE: StageSaved = { order: [], trees: {}, soloTileId: null };

export type StageView = {
  readonly order: readonly string[];
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  readonly tree: SplitNode | null;
  readonly panes: readonly StagePane[];
  readonly splitters: readonly StageSplitter[];
  /** The page's tree is a user-adjusted one. */
  readonly adjusted: boolean;
  readonly soloTileId: string | null;
};

export function pageKey(tileIds: readonly string[]): string {
  return [...tileIds].sort().join('|');
}

/**
 * Pane order for a stage: the saved order for windows still present, then newcomers in their
 * natural (reading) order.
 */
export function stageOrder(saved: readonly string[], natural: readonly string[]): string[] {
  const present = new Set(natural);
  const kept = saved.filter((id) => present.has(id));
  const keptSet = new Set(kept);
  return [...kept, ...natural.filter((id) => !keptSet.has(id))];
}

/** Everything the stage renders for one page. */
export function stageView(
  natural: readonly string[],
  saved: StageSaved,
  area: Box,
  requestedPage: number
): StageView {
  const order = stageOrder(saved.order, natural);
  const solo = saved.soloTileId && order.includes(saved.soloTileId) ? saved.soloTileId : null;
  if (solo) {
    const tree = leaf(solo);
    return {
      order,
      page: 0,
      pageCount: 1,
      pageSize: 1,
      tree,
      panes: layoutTree(tree, area),
      splitters: [],
      adjusted: false,
      soloTileId: solo,
    };
  }
  const size = pageSizeFor(order, area);
  const pageCount = Math.max(1, Math.ceil(order.length / size));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const ids = order.slice(page * size, page * size + size);
  const aspect = area.h > 0 ? area.w / area.h : 16 / 9;
  const stored = saved.trees[pageKey(ids)];
  const usable =
    stored && sameOrderedSet(leafOrder(stored), ids) && fitsMinimums(stored, area) ? stored : null;
  const tree = usable ?? templateTree(ids, aspect);
  return {
    order,
    page,
    pageCount,
    pageSize: size,
    tree,
    panes: layoutTree(tree, area),
    splitters: treeSplitters(tree, area),
    adjusted: usable !== null,
    soloTileId: null,
  };
}

function sameOrderedSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

// ── Edits ────────────────────────────────────────────────────────────────────

function nodeAt(tree: SplitNode, path: readonly number[]): SplitNode | null {
  let node: SplitNode = tree;
  for (const index of path) {
    if (node.type !== 'split') return null;
    const child = node.children[index];
    if (!child) return null;
    node = child;
  }
  return node;
}

function replaceAt(tree: SplitNode, path: readonly number[], next: SplitNode): SplitNode {
  if (path.length === 0) return next;
  if (tree.type !== 'split') return tree;
  const [head, ...rest] = path as [number, ...number[]];
  return {
    ...tree,
    children: tree.children.map((child, index) =>
      index === head ? replaceAt(child, rest, next) : child
    ),
  };
}

/** Moves the splitter after child `index` of the split at `path` by `delta` (ratio units). */
export function moveSplitter(
  tree: SplitNode,
  path: readonly number[],
  index: number,
  delta: number
): SplitNode {
  const node = nodeAt(tree, path);
  if (!node || node.type !== 'split') return tree;
  const total = node.ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
  const ratios = node.ratios.map((ratio) => ratio / total);
  const a = ratios[index];
  const b = ratios[index + 1];
  if (a === undefined || b === undefined) return tree;
  const pair = a + b;
  const nextA = Math.min(pair - MIN_RATIO, Math.max(MIN_RATIO, a + delta));
  ratios[index] = nextA;
  ratios[index + 1] = pair - nextA;
  return replaceAt(tree, path, { ...node, ratios });
}

function pathTo(tree: SplitNode, tileId: string, path: number[] = []): number[] | null {
  if (tree.type === 'leaf') return tree.tileId === tileId ? path : null;
  for (const [index, child] of tree.children.entries()) {
    const found = pathTo(child, tileId, [...path, index]);
    if (found) return found;
  }
  return null;
}

/**
 * Gives a pane more (or less) of its split: "make the browser bigger". Grows the pane's share in
 * its nearest split by `factor`, taking the space from its siblings proportionally.
 */
export function scalePane(tree: SplitNode, tileId: string, factor: number): SplitNode {
  const path = pathTo(tree, tileId);
  if (!path || path.length === 0) return tree;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;
  const parent = nodeAt(tree, parentPath);
  if (!parent || parent.type !== 'split') return tree;
  const total = parent.ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
  const ratios = parent.ratios.map((ratio) => ratio / total);
  const current = ratios[index] ?? 0;
  const maxShare = 1 - MIN_RATIO * (ratios.length - 1);
  const next = Math.min(maxShare, Math.max(MIN_RATIO, current * factor));
  const others = 1 - current;
  const scaled = ratios.map((ratio, i) =>
    i === index
      ? next
      : others > 0
        ? (ratio / others) * (1 - next)
        : (1 - next) / (ratios.length - 1)
  );
  return replaceAt(tree, parentPath, { ...parent, ratios: scaled });
}

/** The share (0..1) a pane has of its nearest split, for summaries. */
export function paneShare(tree: SplitNode, tileId: string): number {
  const path = pathTo(tree, tileId);
  if (!path || path.length === 0) return 1;
  const parent = nodeAt(tree, path.slice(0, -1));
  if (!parent || parent.type !== 'split') return 1;
  const total = parent.ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
  return (parent.ratios[path[path.length - 1] as number] ?? 0) / total;
}

/** Swaps two panes in pane order. */
export function swapInOrder(order: readonly string[], a: string, b: string): string[] {
  const next = [...order];
  const i = next.indexOf(a);
  const j = next.indexOf(b);
  if (i === -1 || j === -1) return next;
  next[i] = b;
  next[j] = a;
  return next;
}

/** Moves a pane to a position in pane order ('first', 'last', or 0-based index). */
export function reorder(
  order: readonly string[],
  tileId: string,
  position: 'first' | 'last' | number
): string[] {
  const rest = order.filter((id) => id !== tileId);
  if (!order.includes(tileId)) return [...order];
  const index =
    position === 'first'
      ? 0
      : position === 'last'
        ? rest.length
        : Math.max(0, Math.min(rest.length, position));
  return [...rest.slice(0, index), tileId, ...rest.slice(index)];
}

/** Pane that sits in a direction from `tileId` (for "move Atlas left" inside a stage). */
export function paneInDirection(
  panes: readonly StagePane[],
  tileId: string,
  direction: 'left' | 'right' | 'up' | 'down'
): string | null {
  const from = panes.find((pane) => pane.tileId === tileId);
  if (!from) return null;
  const cx = from.rect.x + from.rect.w / 2;
  const cy = from.rect.y + from.rect.h / 2;
  let best: { id: string; score: number } | null = null;
  for (const pane of panes) {
    if (pane.tileId === tileId) continue;
    const px = pane.rect.x + pane.rect.w / 2;
    const py = pane.rect.y + pane.rect.h / 2;
    const dx = px - cx;
    const dy = py - cy;
    const along =
      direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    if (along <= 1) continue;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2;
    if (!best || score < best.score) best = { id: pane.tileId, score };
  }
  return best?.id ?? null;
}
