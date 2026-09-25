/**
 * The layout planner: every input (pointer, keyboard, palette, grammar, the conductor's model)
 * compiles to `LayoutOp`s, and `planLayout` turns them into a new `LayoutState` plus a summary.
 *
 * Pure and deterministic. Rules for anything the system places:
 * - siblings (windows and regions in the same parent) do not overlap;
 * - a region always contains its members (it grows to fit, rigidly pushing its own siblings);
 * - pushes cascade within one parent and are budgeted, falling back to a free spot.
 * The vocabulary has no absolute coordinates except `exact`, which only the pointer path builds.
 */

import {
  AGENT_TILE_SIZE,
  boundsOf,
  rectsOverlap,
  TILE_GAP,
  viewportRect,
  type CanvasViewport,
  type TileRect,
} from './canvas-model';
import {
  childRegions,
  contentBox,
  defaultSizeOf,
  descendantRegions,
  descendantTiles,
  GRID,
  isRegionId,
  MAX_REGION_DEPTH,
  minSizeOf,
  MIN_REGION_SIZE,
  nameKey,
  newRegionId,
  nextRegionName,
  nodeRect,
  parentOf,
  REGION_COLORS,
  regionDepth,
  STATUS_GROUPS,
  subtreeHeight,
  tileRectOf,
  uniqueName,
  wrapRect,
  type LayoutState,
  type LayoutWindow,
  type RegionColor,
  type RegionState,
  type WindowStatus,
} from './canvas-regions';

export type Slot =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Amount = 'bit' | 'some' | 'far';
export type Side = 'left' | 'right' | 'above' | 'below';

export type Destination =
  /** Into a region (null = the board root). */
  | { readonly kind: 'region'; readonly region: string | null }
  | { readonly kind: 'relative'; readonly anchor: string; readonly side: Side }
  | { readonly kind: 'slot'; readonly slot: Slot }
  | { readonly kind: 'nudge'; readonly direction: Direction; readonly amount: Amount }
  /** Pointer drops only: a position and the region the drop landed in. */
  | {
      readonly kind: 'exact';
      readonly x: number;
      readonly y: number;
      readonly region: string | null;
    };

export type SizeSpec =
  | {
      readonly kind: 'preset';
      readonly preset: 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'default';
    }
  | {
      readonly kind: 'relative';
      readonly axis: 'both' | 'width' | 'height';
      readonly factor: 'bit' | 'more' | 'much' | 'double' | 'half';
      readonly direction: 'grow' | 'shrink';
    }
  | {
      readonly kind: 'screen';
      readonly fraction: 'half' | 'third' | 'quarter' | 'full';
      readonly axis: 'width' | 'height' | 'both';
    }
  | { readonly kind: 'match'; readonly like: string }
  /** Pointer resizes only. */
  | { readonly kind: 'exact'; readonly rect: TileRect };

export type ArrangeLayout = 'grid' | 'row' | 'column' | 'tidy';
export type OrganizeBy = 'task' | 'project' | 'status' | 'provider';

export type LayoutOp =
  | { readonly op: 'move'; readonly targets: readonly string[]; readonly to: Destination }
  | { readonly op: 'resize'; readonly targets: readonly string[]; readonly size: SizeSpec }
  | {
      readonly op: 'arrange';
      /** Null arranges everything directly in `scope`. */
      readonly targets: readonly string[] | null;
      readonly scope: string | null;
      readonly layout: ArrangeLayout;
    }
  | { readonly op: 'organize'; readonly scope: string | null; readonly by: OrganizeBy }
  | { readonly op: 'swap'; readonly a: string; readonly b: string }
  | {
      readonly op: 'createRegion';
      readonly name?: string;
      readonly members: readonly string[];
      readonly parent?: string | null;
      readonly color?: RegionColor;
    }
  | { readonly op: 'renameRegion'; readonly region: string; readonly name: string }
  | { readonly op: 'recolorRegion'; readonly region: string; readonly color: RegionColor | null }
  | { readonly op: 'dissolveRegion'; readonly region: string }
  | { readonly op: 'collapseRegion'; readonly region: string; readonly collapsed: boolean }
  | { readonly op: 'fitRegion'; readonly region: string }
  | { readonly op: 'hide'; readonly targets: readonly string[] }
  | { readonly op: 'show'; readonly targets: readonly string[] };

export type LayoutEnv = {
  /** Every window that exists (hidden ones included). */
  readonly windows: readonly LayoutWindow[];
  /** Canvas viewport size in CSS px. */
  readonly screen: { readonly width: number; readonly height: number };
  readonly viewport: CanvasViewport;
  /** Space reserved above tiles for task frames (0 when frames are off). */
  readonly frameAllowance: number;
  readonly now: number;
  readonly newId: () => string;
};

export type LayoutTier = 'immediate' | 'preview';

export type LayoutPlan = {
  readonly state: LayoutState;
  /** One short sentence per applied op. */
  readonly summary: string;
  /** Ids the ops acted on or created. */
  readonly targets: readonly string[];
  /** Windows and regions moved that nobody named. */
  readonly displaced: readonly string[];
  readonly created: readonly string[];
  /** Why ops failed (the rest still apply). */
  readonly failures: readonly string[];
  readonly tier: LayoutTier;
  /** Windows whose rect, region, or visibility changed. */
  readonly touchedWindows: number;
};

export type PlanResult = { ok: true; plan: LayoutPlan } | { ok: false; reason: string };

// ── Constants ────────────────────────────────────────────────────────────────

export const NUDGE_STEPS: Record<Amount, number> = { bit: 1, some: 4, far: 12 };
export const RELATIVE_FACTORS = { bit: 1.15, more: 1.25, much: 1.5, double: 2, half: 2 } as const;
export const SIZE_PRESETS = {
  small: { w: 480, h: 300 },
  medium: { w: AGENT_TILE_SIZE.w, h: AGENT_TILE_SIZE.h },
  large: { w: 1080, h: 690 },
  wide: { w: 1440, h: 460 },
  tall: { w: 720, h: 920 },
} as const;
/** Push budget: beyond this a move lands in the nearest free spot instead. */
export const MAX_PUSHED = 4;
/** Preview tier thresholds. */
export const PREVIEW_TOUCHED_WINDOWS = 4;
export const PREVIEW_DISPLACED = 2;
/** Batch cap, mirroring propose_plan. */
export const MAX_OPS_PER_BATCH = 12;
/** Rows in reading order: rects whose tops are this close share a row. */
const ROW_BAND = 160;

// ── Draft ────────────────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Draft {
  tiles: Record<string, TileRect>;
  regions: Record<string, RegionState>;
  membership: Record<string, string>;
  hidden: string[];
  readonly present: Set<string>;
  readonly windows: Map<string, LayoutWindow>;
  readonly targets = new Set<string>();
  readonly displaced = new Set<string>();
  readonly created: string[] = [];
  readonly failures: string[] = [];
  readonly summaries: string[] = [];
  forcePreview = false;

  constructor(
    state: LayoutState,
    readonly env: LayoutEnv
  ) {
    this.tiles = { ...state.tiles };
    this.regions = { ...state.regions };
    this.membership = { ...state.membership };
    this.hidden = [...state.hidden];
    this.windows = new Map(env.windows.map((window) => [window.tileId, window]));
    this.present = new Set(env.windows.map((window) => window.tileId));
  }

  get state(): LayoutState {
    return {
      tiles: this.tiles,
      regions: this.regions,
      membership: this.membership,
      hidden: this.hidden,
    };
  }

  snapshot(): LayoutState {
    return {
      tiles: { ...this.tiles },
      regions: { ...this.regions },
      membership: { ...this.membership },
      hidden: [...this.hidden],
    };
  }

  restore(state: LayoutState): void {
    this.tiles = { ...state.tiles };
    this.regions = { ...state.regions };
    this.membership = { ...state.membership };
    this.hidden = [...state.hidden];
  }

  exists(id: string): boolean {
    return isRegionId(id) ? Boolean(this.regions[id]) : this.present.has(id);
  }

  isHidden(id: string): boolean {
    return this.hidden.includes(id);
  }

  parent(id: string): string | null {
    return parentOf(this.state, id);
  }

  rect(id: string): TileRect {
    return nodeRect(this.state, id);
  }

  /** Direct children that take up space: visible present windows and regions. */
  children(parentId: string | null): string[] {
    const tiles = [...this.present].filter(
      (id) => !this.isHidden(id) && this.parent(id) === parentId
    );
    return [...tiles.sort(), ...childRegions(this.state, parentId)];
  }

  name(id: string): string {
    if (isRegionId(id)) return this.regions[id]?.name ?? 'that region';
    return this.windows.get(id)?.name ?? 'that window';
  }

  setTile(id: string, rect: TileRect): void {
    this.tiles[id] = roundRect(rect);
  }

  setRegion(id: string, patch: Partial<RegionState>): void {
    const region = this.regions[id];
    if (!region) return;
    this.regions[id] = {
      ...region,
      ...patch,
      ...(patch.rect ? { rect: roundRect(patch.rect) } : {}),
    };
  }

  setParent(id: string, parentId: string | null): void {
    if (isRegionId(id)) {
      this.setRegion(id, { parentId });
      return;
    }
    if (parentId) this.membership[id] = parentId;
    else delete this.membership[id];
  }

  /** Moves a node; a region moves with everything inside it. */
  translate(id: string, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (!isRegionId(id)) {
      const rect = tileRectOf(this.state, id);
      this.setTile(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
      return;
    }
    const regions = [id, ...descendantRegions(this.state, id)];
    for (const regionId of regions) {
      const region = this.regions[regionId];
      if (region) {
        this.setRegion(regionId, {
          rect: { ...region.rect, x: region.rect.x + dx, y: region.rect.y + dy },
        });
      }
    }
    for (const tileId of descendantTiles(this.state, id)) {
      const rect = tileRectOf(this.state, tileId);
      this.setTile(tileId, { ...rect, x: rect.x + dx, y: rect.y + dy });
    }
  }

  moveTo(id: string, x: number, y: number): void {
    const rect = this.rect(id);
    this.translate(id, x - rect.x, y - rect.y);
  }

  displace(id: string): void {
    if (!this.targets.has(id)) this.displaced.add(id);
  }
}

function roundRect(rect: TileRect): TileRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
  };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Reading order: row bands top to bottom, then left to right. */
export function readingOrder(ids: readonly string[], rectOf: (id: string) => TileRect): string[] {
  const withRects = ids.map((id) => ({ id, rect: rectOf(id) }));
  withRects.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: { top: number; items: typeof withRects }[] = [];
  for (const item of withRects) {
    const row = rows.find((candidate) => Math.abs(candidate.top - item.rect.y) <= ROW_BAND);
    if (row) row.items.push(item);
    else rows.push({ top: item.rect.y, items: [item] });
  }
  return rows.flatMap((row) =>
    row.items.sort((a, b) => a.rect.x - b.rect.x || a.id.localeCompare(b.id)).map((i) => i.id)
  );
}

/**
 * First spot in reading order where `size` fits without touching `occupied` (with TILE_GAP), no
 * further right than `origin.x + maxWidth` unless nothing else fits.
 */
export function findFreeSpot(
  occupied: readonly TileRect[],
  size: { w: number; h: number },
  origin: { x: number; y: number },
  maxWidth: number
): { x: number; y: number } {
  const limit = origin.x + Math.max(maxWidth, size.w);
  const candidates: { x: number; y: number }[] = [{ ...origin }];
  for (const rect of occupied) {
    candidates.push({ x: rect.x + rect.w + TILE_GAP, y: rect.y });
    candidates.push({ x: rect.x, y: rect.y + rect.h + TILE_GAP });
    candidates.push({ x: origin.x, y: rect.y + rect.h + TILE_GAP });
  }
  const fits = (spot: { x: number; y: number }) => {
    if (spot.x < origin.x || spot.y < origin.y) return false;
    if (spot.x + size.w > limit) return false;
    const candidate = { x: spot.x, y: spot.y, w: size.w, h: size.h };
    return !occupied.some((rect) => rectsOverlap(rect, candidate, TILE_GAP / 2));
  };
  const valid = candidates.filter(fits).sort((a, b) => a.y - b.y || a.x - b.x);
  if (valid[0]) return valid[0];
  const bottom = Math.max(origin.y, ...occupied.map((rect) => rect.y + rect.h + TILE_GAP));
  return { x: origin.x, y: bottom };
}

/** Shelf layout: rows of `columns` items, each row as tall as its tallest item. */
function shelfPositions(
  sizes: readonly { w: number; h: number }[],
  origin: { x: number; y: number },
  columns: number
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  let y = origin.y;
  for (let start = 0; start < sizes.length; start += columns) {
    const row = sizes.slice(start, start + columns);
    let x = origin.x;
    for (const size of row) {
      positions.push({ x, y });
      x += size.w + TILE_GAP;
    }
    y += Math.max(...row.map((size) => size.h)) + TILE_GAP;
  }
  return positions;
}

/** Columns for a tidy grid of `count` items that reads well on a screen of `aspect` (w/h). */
export function tidyColumns(count: number, itemAspect: number, screenAspect: number): number {
  if (count <= 1) return 1;
  // Columns c with rows r = ceil(n/c) so that (c * itemAspect) / r is closest to the screen.
  let best = 1;
  let bestScore = Infinity;
  for (let columns = 1; columns <= Math.min(count, 6); columns++) {
    const rows = Math.ceil(count / columns);
    const aspect = (columns * itemAspect) / rows;
    const empty = columns * rows - count;
    const score = Math.abs(Math.log(aspect / screenAspect)) + empty * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = columns;
    }
  }
  return best;
}

function screenAspect(env: LayoutEnv): number {
  return env.screen.height > 0 ? env.screen.width / env.screen.height : 16 / 9;
}

// ── Structural invariants ────────────────────────────────────────────────────

/** Grows `regionId` (and its ancestors) to contain their members, pushing siblings aside. */
function growToFit(draft: Draft, regionId: string | null, depth = 0): void {
  if (!regionId || depth > MAX_REGION_DEPTH + 1) return;
  const region = draft.regions[regionId];
  if (!region) return;
  if (!region.collapsed) {
    const needed = wrapRect(
      draft.children(regionId).map((child) => draft.rect(child)),
      draft.env.frameAllowance
    );
    if (needed) {
      const current = region.rect;
      const x = Math.min(current.x, needed.x);
      const y = Math.min(current.y, needed.y);
      const right = Math.max(current.x + current.w, needed.x + needed.w);
      const bottom = Math.max(current.y + current.h, needed.y + needed.h);
      const grown = { x, y, w: right - x, h: bottom - y };
      if (
        grown.x !== current.x ||
        grown.y !== current.y ||
        grown.w !== current.w ||
        grown.h !== current.h
      ) {
        draft.setRegion(regionId, { rect: grown });
        pushSiblings(draft, regionId);
      }
    }
  }
  growToFit(draft, draft.parent(regionId), depth + 1);
}

/** Shrink-wraps a region around its members (keeps its size when empty). */
function wrapRegion(draft: Draft, regionId: string): void {
  const region = draft.regions[regionId];
  if (!region) return;
  const needed = wrapRect(
    draft.children(regionId).map((child) => draft.rect(child)),
    draft.env.frameAllowance
  );
  if (needed) draft.setRegion(regionId, { rect: needed });
  pushSiblings(draft, regionId);
  growToFit(draft, draft.parent(regionId));
}

/**
 * Pushes siblings that overlap `causeId` away along the axis of least penetration, cascading
 * within the same parent. The cause (and `pinned`) never move, and a push never lands a sibling on
 * them. Anything a bounded cascade leaves overlapping goes to the nearest free spot. Returns the
 * ids moved.
 */
function pushSiblings(
  draft: Draft,
  causeId: string,
  pinned: ReadonlySet<string> = new Set()
): string[] {
  const parentId = draft.parent(causeId);
  const moved: string[] = [];
  const moves = new Map<string, number>();
  const fixed = new Set([causeId, ...pinned]);
  const siblings = () => draft.children(parentId);
  const clearOfFixed = (id: string, rect: TileRect) =>
    [...fixed].every(
      (other) =>
        other === id ||
        draft.parent(other) !== parentId ||
        !rectsOverlap(draft.rect(other), rect, TILE_GAP / 2)
    );
  const queue = [causeId];
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const cause = queue.shift() as string;
    const causeRect = draft.rect(cause);
    for (const sibling of siblings()) {
      if (fixed.has(sibling) || sibling === cause) continue;
      const rect = draft.rect(sibling);
      if (!rectsOverlap(causeRect, rect, TILE_GAP / 2)) continue;
      const count = moves.get(sibling) ?? 0;
      if (count >= 3) continue;
      moves.set(sibling, count + 1);
      const options = pushVectors(causeRect, rect);
      const vector =
        options.find(({ dx, dy }) =>
          clearOfFixed(sibling, { ...rect, x: rect.x + dx, y: rect.y + dy })
        ) ?? options[0];
      if (!vector) continue;
      draft.translate(sibling, vector.dx, vector.dy);
      draft.displace(sibling);
      moved.push(sibling);
      queue.push(sibling);
    }
  }
  // Whatever the cascade could not clear goes to the nearest free spot.
  for (let pass = 0; pass < 32; pass++) {
    const nodes = siblings();
    let conflict: string | null = null;
    for (let i = 0; i < nodes.length && !conflict; i++) {
      for (let j = i + 1; j < nodes.length && !conflict; j++) {
        const a = nodes[i] as string;
        const b = nodes[j] as string;
        if (!rectsOverlap(draft.rect(a), draft.rect(b), 0)) continue;
        const involved = (id: string) => moved.includes(id) || fixed.has(id);
        if (!involved(a) && !involved(b)) continue;
        // Move the one that is not fixed, preferring one that was already pushed.
        if (fixed.has(a)) conflict = b;
        else if (fixed.has(b)) conflict = a;
        else conflict = moved.includes(b) ? b : a;
      }
    }
    if (!conflict) break;
    const rect = draft.rect(conflict);
    const occupied = nodes.filter((id) => id !== conflict).map((id) => draft.rect(id));
    const spot = nearestFreeSpot(occupied, rect);
    draft.moveTo(conflict, spot.x, spot.y);
    draft.displace(conflict);
    moved.push(conflict);
  }
  if (moved.length > 0) growToFit(draft, parentId);
  return moved;
}

/**
 * The four ways out of an overlap: the two that lead away from the cause first (least
 * penetration first), then the other two.
 */
function pushVectors(cause: TileRect, rect: TileRect): { dx: number; dy: number }[] {
  const awayRight = rect.x + rect.w / 2 >= cause.x + cause.w / 2;
  const awayDown = rect.y + rect.h / 2 >= cause.y + cause.h / 2;
  const options = [
    { dx: cause.x + cause.w + TILE_GAP - rect.x, dy: 0, away: awayRight },
    { dx: -(rect.x + rect.w + TILE_GAP - cause.x), dy: 0, away: !awayRight },
    { dx: 0, dy: cause.y + cause.h + TILE_GAP - rect.y, away: awayDown },
    { dx: 0, dy: -(rect.y + rect.h + TILE_GAP - cause.y), away: !awayDown },
  ];
  return options
    .sort((a, b) => {
      if (a.away !== b.away) return Number(b.away) - Number(a.away);
      return Math.abs(a.dx + a.dy) - Math.abs(b.dx + b.dy);
    })
    .map(({ dx, dy }) => ({ dx, dy }));
}

/** Whether `id` may move into `parentId` without breaking the tree (cycles, depth cap). */
function canReparent(draft: Draft, id: string, parentId: string | null): string | null {
  if (!parentId) return null;
  if (!draft.regions[parentId]) return 'That region no longer exists.';
  if (!isRegionId(id)) return null;
  if (id === parentId || descendantRegions(draft.state, id).includes(parentId)) {
    return `${draft.name(id)} can't go inside itself.`;
  }
  const depth = regionDepth(draft.state, parentId) + subtreeHeight(draft.state, id);
  if (depth > MAX_REGION_DEPTH) {
    return `Regions nest at most ${MAX_REGION_DEPTH} deep.`;
  }
  return null;
}

/** Places `id` inside `parentId` at the first free spot (the region grows to fit). */
function placeInside(draft: Draft, id: string, parentId: string | null, near?: TileRect): void {
  draft.setParent(id, parentId);
  const size = draft.rect(id);
  const occupied = draft
    .children(parentId)
    .filter((child) => child !== id && !(isRegionId(id) && isWithinDraft(draft, child, id)))
    .map((child) => draft.rect(child));
  let origin: { x: number; y: number };
  let maxWidth: number;
  if (parentId) {
    const region = draft.regions[parentId] as RegionState;
    const box = contentBox(region, draft.env.frameAllowance);
    const count = occupied.length + 1;
    const columns = Math.min(3, Math.ceil(Math.sqrt(count)));
    origin = { x: box.x, y: box.y };
    maxWidth = Math.max(box.w, columns * (size.w + TILE_GAP) - TILE_GAP);
  } else {
    // Out of a region: just right of where it came from; otherwise right of everything.
    const anchor = near ?? boundsOf(occupied);
    origin = anchor ? { x: anchor.x + anchor.w + TILE_GAP, y: anchor.y } : { x: 0, y: 0 };
    maxWidth = 3 * (size.w + TILE_GAP);
  }
  const spot = findFreeSpot(occupied, size, origin, maxWidth);
  draft.moveTo(id, spot.x, spot.y);
  growToFit(draft, parentId);
}

function isWithinDraft(draft: Draft, id: string, ancestor: string): boolean {
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = draft.parent(current);
  }
  return false;
}

/**
 * Pushes around a node that was just positioned, within budget. Over budget, the node goes to the
 * nearest free spot in its parent instead and the summary says so.
 */
function settle(draft: Draft, id: string, before: LayoutState): 'pushed' | 'relocated' | 'clear' {
  const displacedBefore = new Set(draft.displaced);
  const origin = { ...draft.rect(id) };
  const moved = pushSiblings(draft, id);
  if (moved.length === 0) {
    growToFit(draft, draft.parent(id));
    return 'clear';
  }
  const unique = new Set(moved);
  const far = [...unique].some((sibling) => {
    const was = nodeRect(before, sibling);
    const now = draft.rect(sibling);
    return Math.hypot(now.x - was.x, now.y - was.y) > Math.max(was.w, AGENT_TILE_SIZE.w);
  });
  if (unique.size <= MAX_PUSHED && !far) {
    growToFit(draft, draft.parent(id));
    return 'pushed';
  }
  // Over budget: undo the pushes and take the nearest free spot instead.
  const parentId = draft.parent(id);
  const idRect = origin;
  draft.restore(before);
  draft.displaced.clear();
  for (const displaced of displacedBefore) draft.displaced.add(displaced);
  draft.setParent(id, parentId);
  const occupied = draft
    .children(parentId)
    .filter((child) => child !== id && !(isRegionId(id) && isWithinDraft(draft, child, id)))
    .map((child) => draft.rect(child));
  const spot = nearestFreeSpot(occupied, idRect);
  draft.moveTo(id, spot.x, spot.y);
  growToFit(draft, parentId);
  return 'relocated';
}

/** The free spot closest to `rect`'s position (searching outward on the grid). */
export function nearestFreeSpot(
  occupied: readonly TileRect[],
  rect: TileRect
): { x: number; y: number } {
  const free = (x: number, y: number) =>
    !occupied.some((other) => rectsOverlap(other, { x, y, w: rect.w, h: rect.h }, TILE_GAP / 2));
  if (free(rect.x, rect.y)) return { x: rect.x, y: rect.y };
  const step = GRID * 4;
  for (let ring = 1; ring <= 80; ring++) {
    const candidates: { x: number; y: number; d: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ] as const) {
        const x = rect.x + dx * step;
        const y = rect.y + dy * step;
        if (free(x, y)) candidates.push({ x, y, d: Math.hypot(dx, dy) + (dy < 0 ? 0.25 : 0) });
      }
    }
    candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
    if (candidates[0]) return { x: candidates[0].x, y: candidates[0].y };
  }
  return { x: rect.x, y: rect.y };
}

// ── Ops ──────────────────────────────────────────────────────────────────────

type OpResult = string | { error: string };

function requireNodes(draft: Draft, ids: readonly string[]): string[] | { error: string } {
  const known = ids.filter((id) => draft.exists(id));
  if (known.length === 0) return { error: 'Nothing to act on: those windows are gone.' };
  return [...new Set(known)];
}

function listNames(names: readonly string[], max = 3): string {
  if (names.length === 0) return 'nothing';
  if (names.length === 1) return names[0] as string;
  if (names.length > max) return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function describeWhere(draft: Draft, parentId: string | null): string {
  return parentId ? draft.name(parentId) : 'the board';
}

function opMove(draft: Draft, targets: readonly string[], to: Destination): OpResult {
  const ids = requireNodes(draft, targets);
  if ('error' in ids) return ids;
  for (const id of ids) draft.targets.add(id);
  const names = listNames(ids.map((id) => draft.name(id)));

  switch (to.kind) {
    case 'region': {
      for (const id of ids) {
        const problem = canReparent(draft, id, to.region);
        if (problem) return { error: problem };
      }
      const already = ids.every((id) => draft.parent(id) === to.region);
      if (already)
        return `${names} ${ids.length === 1 ? 'is' : 'are'} already in ${describeWhere(draft, to.region)}.`;
      for (const id of ids) {
        const from = draft.parent(id);
        const near = from ? draft.regions[from]?.rect : undefined;
        placeInside(draft, id, to.region, to.region ? undefined : near);
      }
      if (to.region) draft.targets.add(to.region);
      return `Moved ${names} into ${describeWhere(draft, to.region)}.`;
    }
    case 'relative': {
      if (!draft.exists(to.anchor)) return { error: 'The window to place it next to is gone.' };
      if (ids.includes(to.anchor))
        return { error: `Can't place ${draft.name(to.anchor)} next to itself.` };
      const parentId = draft.parent(to.anchor);
      for (const id of ids) {
        const problem = canReparent(draft, id, parentId);
        if (problem) return { error: problem };
        if (isRegionId(id) && isWithinDraft(draft, to.anchor, id)) {
          return { error: `${draft.name(to.anchor)} is inside ${draft.name(id)}.` };
        }
      }
      let anchorRect = draft.rect(to.anchor);
      let relocated = false;
      for (const id of ids) {
        const before = draft.snapshot();
        draft.setParent(id, parentId);
        const rect = draft.rect(id);
        const pos = relativePosition(anchorRect, rect, to.side);
        draft.moveTo(id, pos.x, pos.y);
        if (settle(draft, id, before) === 'relocated') relocated = true;
        // Several windows line up one after another on that side.
        anchorRect = draft.rect(id);
      }
      const where = `${sideWord(to.side)} ${draft.name(to.anchor)}`;
      return relocated
        ? `No room ${where}, so ${names} went to the nearest free spot.`
        : `Put ${names} ${where}.`;
    }
    case 'slot': {
      for (const id of ids) {
        const parentId = draft.parent(id);
        const scope = parentId
          ? contentBox(draft.regions[parentId] as RegionState, draft.env.frameAllowance)
          : viewportRect(draft.env.viewport, draft.env.screen);
        const rect = draft.rect(id);
        const pos = slotPosition(scope, rect, to.slot);
        const before = draft.snapshot();
        draft.moveTo(id, pos.x, pos.y);
        settle(draft, id, before);
      }
      return `Moved ${names} to the ${to.slot.replace('-', ' ')}.`;
    }
    case 'nudge': {
      const step = NUDGE_STEPS[to.amount] * GRID;
      const dx = to.direction === 'left' ? -step : to.direction === 'right' ? step : 0;
      const dy = to.direction === 'up' ? -step : to.direction === 'down' ? step : 0;
      const pinned = new Set(ids);
      for (const id of ids) draft.translate(id, dx, dy);
      for (const id of ids) {
        pushSiblings(draft, id, pinned);
        growToFit(draft, draft.parent(id));
      }
      return `Moved ${names} ${to.direction === 'up' || to.direction === 'down' ? to.direction : `to the ${to.direction}`}.`;
    }
    case 'exact': {
      const [id] = ids;
      if (!id) return { error: 'Nothing to move.' };
      const problem = canReparent(draft, id, to.region);
      const region = problem ? draft.parent(id) : to.region;
      const from = draft.parent(id);
      draft.setParent(id, region);
      draft.moveTo(id, to.x, to.y);
      growToFit(draft, region);
      return region !== from
        ? `Moved ${names} into ${describeWhere(draft, region)}.`
        : `Moved ${names}.`;
    }
  }
}

function relativePosition(anchor: TileRect, rect: TileRect, side: Side): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: anchor.x - TILE_GAP - rect.w, y: anchor.y };
    case 'right':
      return { x: anchor.x + anchor.w + TILE_GAP, y: anchor.y };
    case 'above':
      return { x: anchor.x, y: anchor.y - TILE_GAP - rect.h };
    case 'below':
      return { x: anchor.x, y: anchor.y + anchor.h + TILE_GAP };
  }
}

function sideWord(side: Side): string {
  switch (side) {
    case 'left':
      return 'left of';
    case 'right':
      return 'right of';
    case 'above':
      return 'above';
    case 'below':
      return 'below';
  }
}

function slotPosition(scope: TileRect, rect: TileRect, slot: Slot): { x: number; y: number } {
  const horizontal = slot.includes('left') ? 'left' : slot.includes('right') ? 'right' : 'center';
  const vertical = slot.startsWith('top') ? 'top' : slot.startsWith('bottom') ? 'bottom' : 'middle';
  const x =
    horizontal === 'left'
      ? scope.x
      : horizontal === 'right'
        ? scope.x + scope.w - rect.w
        : scope.x + (scope.w - rect.w) / 2;
  const y =
    vertical === 'top'
      ? scope.y
      : vertical === 'bottom'
        ? scope.y + scope.h - rect.h
        : scope.y + (scope.h - rect.h) / 2;
  return { x, y };
}

function opResize(draft: Draft, targets: readonly string[], size: SizeSpec): OpResult {
  const ids = requireNodes(draft, targets);
  if ('error' in ids) return ids;
  for (const id of ids) draft.targets.add(id);
  const like = size.kind === 'match' ? draft.rect(size.like) : null;
  if (size.kind === 'match' && !draft.exists(size.like)) {
    return { error: 'The window to match is gone.' };
  }
  for (const id of ids) {
    const rect = draft.rect(id);
    const next = resizedRect(draft, id, rect, size, like);
    if (isRegionId(id)) {
      const region = draft.regions[id] as RegionState;
      const needed = wrapRect(
        draft.children(id).map((child) => draft.rect(child)),
        draft.env.frameAllowance
      );
      const w = Math.max(next.w, needed ? needed.x + needed.w - rect.x : MIN_REGION_SIZE.w);
      const h = Math.max(next.h, needed ? needed.y + needed.h - rect.y : MIN_REGION_SIZE.h);
      draft.setRegion(id, { rect: { ...region.rect, w, h } });
    } else {
      draft.setTile(id, next);
    }
    pushSiblings(draft, id);
    growToFit(draft, draft.parent(id));
  }
  const names = listNames(ids.map((id) => draft.name(id)));
  return `${names} ${ids.length === 1 ? 'is' : 'are'} now ${describeSize(size)}.`;
}

function resizedRect(
  draft: Draft,
  id: string,
  rect: TileRect,
  size: SizeSpec,
  like: TileRect | null
): TileRect {
  const min = isRegionId(id) ? MIN_REGION_SIZE : minSizeOf(id);
  let w = rect.w;
  let h = rect.h;
  switch (size.kind) {
    case 'preset': {
      const base = size.preset === 'default' ? defaultSizeOf(id) : SIZE_PRESETS[size.preset];
      // Browser presets scale with its larger default.
      const scale =
        !isRegionId(id) && id.startsWith('browser:') && size.preset !== 'default' ? 4 / 3 : 1;
      w = base.w * scale;
      h = base.h * scale;
      break;
    }
    case 'relative': {
      const factor = RELATIVE_FACTORS[size.factor];
      const k = size.factor === 'half' ? 0.5 : size.direction === 'grow' ? factor : 1 / factor;
      const k2 = size.factor === 'half' && size.direction === 'grow' ? 1.5 : k;
      if (size.axis !== 'height') w = rect.w * k2;
      if (size.axis !== 'width') h = rect.h * k2;
      break;
    }
    case 'screen': {
      const fraction = { half: 0.5, third: 1 / 3, quarter: 0.25, full: 1 }[size.fraction];
      const margin = TILE_GAP;
      if (size.axis !== 'height') w = draft.env.screen.width * fraction - margin;
      if (size.axis !== 'width') h = draft.env.screen.height * fraction - margin;
      break;
    }
    case 'match':
      if (like) {
        w = like.w;
        h = like.h;
      }
      break;
    case 'exact':
      return {
        x: size.rect.x,
        y: size.rect.y,
        w: Math.max(min.w, size.rect.w),
        h: Math.max(min.h, size.rect.h),
      };
  }
  // Presets and matches are exact; relative and screen sizes land on the grid.
  const grid = size.kind === 'relative' || size.kind === 'screen';
  return {
    x: rect.x,
    y: rect.y,
    w: Math.max(min.w, grid ? snap(w) : Math.round(w)),
    h: Math.max(min.h, grid ? snap(h) : Math.round(h)),
  };
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function describeSize(size: SizeSpec): string {
  switch (size.kind) {
    case 'preset':
      return size.preset === 'default' ? 'the default size' : size.preset;
    case 'relative':
      return size.direction === 'grow' ? 'bigger' : 'smaller';
    case 'screen':
      return `${size.fraction === 'full' ? 'the full' : `a ${size.fraction} of the`} screen`;
    case 'match':
      return 'the same size';
    case 'exact':
      return 'resized';
  }
}

function opArrange(
  draft: Draft,
  targets: readonly string[] | null,
  scope: string | null,
  layout: ArrangeLayout
): OpResult {
  if (scope && !draft.regions[scope]) return { error: 'That region no longer exists.' };
  const whole = targets === null;
  let ids = whole ? draft.children(scope) : requireNodes(draft, targets);
  if (!Array.isArray(ids)) return ids;
  if (ids.length === 0) return `${describeWhere(draft, scope)} is empty.`;
  const parentId = whole ? scope : draft.parent(ids[0] as string);
  for (const id of ids) {
    const problem = canReparent(draft, id, parentId);
    if (problem) return { error: problem };
  }
  for (const id of ids) {
    draft.targets.add(id);
    draft.setParent(id, parentId);
  }
  ids = readingOrder(ids, (id) => draft.rect(id));
  const sizes = ids.map((id) => {
    const rect = draft.rect(id);
    return { w: rect.w, h: rect.h };
  });
  const bounds = boundsOf(ids.map((id) => draft.rect(id))) as TileRect;
  const origin =
    whole && parentId
      ? (() => {
          const box = contentBox(draft.regions[parentId] as RegionState, draft.env.frameAllowance);
          return { x: box.x, y: box.y };
        })()
      : { x: bounds.x, y: bounds.y };
  const avgAspect =
    sizes.reduce((sum, size) => sum + size.w / Math.max(1, size.h), 0) / sizes.length;
  const columns =
    layout === 'row'
      ? ids.length
      : layout === 'column'
        ? 1
        : layout === 'grid'
          ? Math.ceil(Math.sqrt(ids.length))
          : tidyColumns(ids.length, avgAspect, screenAspect(draft.env));
  const positions = shelfPositions(sizes, origin, columns);
  ids.forEach((id, index) => {
    const pos = positions[index];
    if (pos) draft.moveTo(id, pos.x, pos.y);
  });
  const pinned = new Set(ids);
  if (whole && parentId) {
    wrapRegion(draft, parentId);
  } else {
    for (const id of ids) pushSiblings(draft, id, pinned);
    growToFit(draft, parentId);
  }
  if (whole && !parentId && layout === 'tidy') draft.forcePreview = true;
  const names = whole
    ? `${describeWhere(draft, scope)}`
    : listNames(ids.map((id) => draft.name(id)));
  switch (layout) {
    case 'row':
      return `Lined up ${names} side by side.`;
    case 'column':
      return `Stacked ${names}.`;
    case 'grid':
      return `Put ${names} in a grid.`;
    case 'tidy':
      return `Tidied ${names}.`;
  }
}

function groupKey(
  window: LayoutWindow,
  by: OrganizeBy,
  statusByTask: Map<string, WindowStatus>
): string {
  switch (by) {
    case 'task':
      return window.taskName ?? (window.kind === 'note' ? 'Notes' : 'Other');
    case 'project':
      return window.projectName ?? 'Other';
    case 'provider':
      return window.kind === 'browser' ? 'Apps' : (window.providerLabel ?? 'Other');
    case 'status': {
      const status =
        window.status ?? (window.taskId ? statusByTask.get(window.taskId) : undefined) ?? 'idle';
      return STATUS_GROUPS.find((group) => group.status === status)?.label ?? 'Idle';
    }
  }
}

function opOrganize(draft: Draft, scope: string | null, by: OrganizeBy): OpResult {
  if (scope && !draft.regions[scope]) return { error: 'That region no longer exists.' };
  draft.forcePreview = true;
  const autoRegions = childRegions(draft.state, scope).filter((id) => draft.regions[id]?.auto);
  const looseParents = new Set<string | null>([scope, ...autoRegions]);
  const loose = [...draft.present].filter((id) => {
    if (draft.isHidden(id)) return false;
    const window = draft.windows.get(id);
    if (!window || window.kind === 'note') return false;
    return looseParents.has(draft.parent(id));
  });
  if (loose.length === 0) return `No loose windows to organize in ${describeWhere(draft, scope)}.`;

  const statusByTask = new Map<string, WindowStatus>();
  for (const window of draft.windows.values()) {
    if (
      window.kind === 'agent' &&
      window.taskId &&
      window.status &&
      !statusByTask.has(window.taskId)
    ) {
      statusByTask.set(window.taskId, window.status);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of readingOrder(loose, (tile) => draft.rect(tile))) {
    const window = draft.windows.get(id) as LayoutWindow;
    const key = groupKey(window, by, statusByTask);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const labels = [...groups.keys()].sort((a, b) => {
    if (by === 'status') {
      const index = (label: string) => STATUS_GROUPS.findIndex((group) => group.label === label);
      return index(a) - index(b);
    }
    return a.localeCompare(b);
  });

  // Detach loose windows so emptied auto regions can be dropped.
  for (const id of loose) draft.setParent(id, scope);
  const windowNames = [...draft.windows.values()].map((window) => window.name);
  const regionIds: string[] = [];
  labels.forEach((label, index) => {
    const members = groups.get(label) ?? [];
    const existing = childRegions(draft.state, scope).find(
      (id) => nameKey(draft.regions[id]?.name ?? '') === nameKey(label)
    );
    let regionId = existing;
    if (!regionId) {
      regionId = newRegionId(draft.env.newId());
      const taken = [...windowNames, ...Object.values(draft.regions).map((region) => region.name)];
      const color =
        by === 'status'
          ? STATUS_GROUPS.find((group) => group.label === label)?.color
          : REGION_COLORS[index % (REGION_COLORS.length - 1)];
      draft.regions[regionId] = {
        name: uniqueName(label, taken),
        parentId: scope,
        rect: { x: 0, y: 0, ...MIN_REGION_SIZE },
        collapsed: false,
        createdAt: draft.env.now,
        auto: true,
        ...(color ? { color } : {}),
      };
      draft.created.push(regionId);
    } else if (draft.regions[regionId]?.collapsed) {
      draft.setRegion(regionId, { collapsed: false });
    }
    const depthProblem = canReparent(draft, members[0] as string, regionId);
    if (depthProblem) return;
    regionIds.push(regionId);
    draft.targets.add(regionId);
    // Members in a compact grid inside the region.
    const region = draft.regions[regionId] as RegionState;
    const box = contentBox(region, draft.env.frameAllowance);
    const already = draft.children(regionId).filter((child) => !members.includes(child));
    const sizes = members.map((id) => draft.rect(id));
    const columns = tidyColumns(
      members.length,
      sizes.reduce((sum, size) => sum + size.w / size.h, 0) / Math.max(1, sizes.length),
      screenAspect(draft.env) * 0.75
    );
    if (already.length === 0) {
      const positions = shelfPositions(sizes, { x: box.x, y: box.y }, columns);
      members.forEach((id, i) => {
        draft.targets.add(id);
        draft.setParent(id, regionId as string);
        const pos = positions[i];
        if (pos) draft.moveTo(id, pos.x, pos.y);
      });
    } else {
      // The region already holds other things (a nested region): fill around them.
      const occupied = already.map((id) => draft.rect(id));
      for (const id of members) {
        draft.targets.add(id);
        draft.setParent(id, regionId as string);
        const size = draft.rect(id);
        const width = Math.max(box.w, columns * (size.w + TILE_GAP) - TILE_GAP);
        const spot = findFreeSpot(occupied, size, { x: box.x, y: box.y }, width);
        draft.moveTo(id, spot.x, spot.y);
        occupied.push(draft.rect(id));
      }
    }
    const wrapped = wrapRect(
      draft.children(regionId).map((child) => draft.rect(child)),
      draft.env.frameAllowance
    );
    if (wrapped) draft.setRegion(regionId, { rect: wrapped });
  });

  // Drop auto regions the regrouping emptied.
  for (const id of autoRegions) {
    if (!draft.regions[id]) continue;
    if (regionIds.includes(id)) continue;
    if (draft.children(id).length === 0 && descendantTiles(draft.state, id).length === 0) {
      delete draft.regions[id];
    }
  }

  // Lay the scope out: the new groups first, then the user's regions and loose notes.
  const children = draft.children(scope);
  const ordered = [
    ...regionIds.filter((id) => children.includes(id)),
    ...readingOrder(
      children.filter((id) => !regionIds.includes(id)),
      (id) => draft.rect(id)
    ),
  ];
  const before = boundsOf(loose.map((id) => tileRectOf(draft.state, id)));
  const box = scope
    ? contentBox(draft.regions[scope] as RegionState, draft.env.frameAllowance)
    : null;
  const origin = box
    ? { x: box.x, y: box.y }
    : (() => {
        const all = boundsOf(children.map((id) => draft.rect(id))) ?? before;
        return all ? { x: all.x, y: all.y } : { x: 0, y: 0 };
      })();
  const sizes = ordered.map((id) => {
    const rect = draft.rect(id);
    return { w: rect.w, h: rect.h };
  });
  const avgAspect =
    sizes.reduce((sum, size) => sum + size.w / size.h, 0) / Math.max(1, sizes.length);
  const positions = shelfPositions(
    sizes,
    origin,
    tidyColumns(ordered.length, avgAspect, screenAspect(draft.env))
  );
  ordered.forEach((id, index) => {
    const pos = positions[index];
    if (pos) draft.moveTo(id, pos.x, pos.y);
    if (!regionIds.includes(id) && id !== scope) draft.displace(id);
  });
  if (scope) wrapRegion(draft, scope);
  const count = regionIds.length;
  return `Organized ${loose.length} window${loose.length === 1 ? '' : 's'} into ${count} region${count === 1 ? '' : 's'} by ${by}.`;
}

function opSwap(draft: Draft, a: string, b: string): OpResult {
  if (!draft.exists(a) || !draft.exists(b)) return { error: 'One of those windows is gone.' };
  if (a === b) return { error: "Can't swap a window with itself." };
  if (isWithinDraft(draft, a, b) || isWithinDraft(draft, b, a)) {
    return { error: "Can't swap a region with something inside it." };
  }
  const parentA = draft.parent(a);
  const parentB = draft.parent(b);
  const problem = canReparent(draft, a, parentB) ?? canReparent(draft, b, parentA);
  if (problem) return { error: problem };
  draft.targets.add(a);
  draft.targets.add(b);
  const rectA = draft.rect(a);
  const rectB = draft.rect(b);
  draft.setParent(a, parentB);
  draft.setParent(b, parentA);
  draft.moveTo(a, rectB.x, rectB.y);
  draft.moveTo(b, rectA.x, rectA.y);
  // Different sizes can make the pair overlap: `a` holds its new place, `b` yields.
  pushSiblings(draft, a);
  pushSiblings(draft, b, new Set([a]));
  growToFit(draft, parentA);
  growToFit(draft, parentB);
  return `Swapped ${draft.name(a)} and ${draft.name(b)}.`;
}

function opCreateRegion(draft: Draft, op: Extract<LayoutOp, { op: 'createRegion' }>): OpResult {
  const members = op.members.filter((id) => draft.exists(id));
  if (op.members.length > 0 && members.length === 0) {
    return { error: 'Those windows are gone.' };
  }
  const parents = new Set(members.map((id) => draft.parent(id)));
  const parentId =
    op.parent !== undefined ? op.parent : parents.size === 1 ? ([...parents][0] ?? null) : null;
  if (parentId && !draft.regions[parentId]) return { error: 'That region no longer exists.' };
  const baseDepth = parentId ? regionDepth(draft.state, parentId) : 0;
  const childHeight = Math.max(
    0,
    ...members.filter(isRegionId).map((id) => subtreeHeight(draft.state, id))
  );
  if (baseDepth + 1 + childHeight > MAX_REGION_DEPTH) {
    return { error: `Regions nest at most ${MAX_REGION_DEPTH} deep.` };
  }
  for (const id of members) {
    if (parentId && isRegionId(id) && isWithinDraft(draft, parentId, id)) {
      return { error: `${draft.name(id)} can't go inside itself.` };
    }
  }

  const windowNames = [...draft.windows.values()].map((window) => window.name);
  const regionNames = Object.values(draft.regions).map((region) => region.name);
  const taken = [...windowNames, ...regionNames];
  const tasks = new Set(
    members.map((id) => draft.windows.get(id)?.taskName).filter((task): task is string => !!task)
  );
  const onlyTask =
    tasks.size === 1 && members.every((id) => !isRegionId(id)) ? [...tasks][0] : undefined;
  const requested = op.name?.trim();
  const name = requested
    ? uniqueName(requested, taken)
    : onlyTask
      ? uniqueName(onlyTask, taken)
      : nextRegionName(taken);
  const renamedBecause =
    requested && nameKey(name) !== nameKey(requested)
      ? ` ("${requested}" was taken, so it is "${name}")`
      : '';

  const id = newRegionId(draft.env.newId());
  draft.created.push(id);
  draft.targets.add(id);
  for (const member of members) draft.targets.add(member);
  const color =
    op.color ?? REGION_COLORS[Object.keys(draft.regions).length % (REGION_COLORS.length - 1)];
  draft.regions[id] = {
    name,
    parentId,
    rect: { x: 0, y: 0, ...MIN_REGION_SIZE },
    collapsed: false,
    createdAt: draft.env.now,
    ...(color ? { color } : {}),
  };

  if (members.length === 0) {
    // An empty region: a free spot in the parent near what the user sees.
    const size = { w: 1200, h: 720 };
    draft.setRegion(id, { rect: { x: 0, y: 0, ...size } });
    const occupied = draft
      .children(parentId)
      .filter((child) => child !== id)
      .map((child) => draft.rect(child));
    const view = viewportRect(draft.env.viewport, draft.env.screen);
    const origin = parentId
      ? contentBox(draft.regions[parentId] as RegionState, draft.env.frameAllowance)
      : view;
    const spot = nearestFreeSpot(occupied, {
      x: origin.x + Math.max(0, (origin.w - size.w) / 2),
      y: origin.y + Math.max(0, (origin.h - size.h) / 2),
      ...size,
    });
    draft.moveTo(id, spot.x, spot.y);
    growToFit(draft, parentId);
    return `Made an empty region called ${name}${renamedBecause}.`;
  }

  // Members keep their places unless a non-member sits among them; then they are packed.
  const ordered = readingOrder(members, (member) => draft.rect(member));
  const memberRects = ordered.map((member) => draft.rect(member));
  const around = wrapRect(memberRects, draft.env.frameAllowance) as TileRect;
  const intruders = draft
    .children(parentId)
    .filter((child) => !members.includes(child) && rectsOverlap(draft.rect(child), around, 0));
  const scattered = new Set(members.map((member) => draft.parent(member))).size > 1;
  for (const member of members) draft.setParent(member, id);
  draft.setParent(id, parentId);
  if (intruders.length > 0 || scattered) {
    const first = memberRects[0] as TileRect;
    const sizes = memberRects.map((rect) => ({ w: rect.w, h: rect.h }));
    const origin = { x: first.x, y: first.y };
    const avgAspect = sizes.reduce((sum, size) => sum + size.w / size.h, 0) / sizes.length;
    const positions = shelfPositions(
      sizes,
      origin,
      tidyColumns(sizes.length, avgAspect, screenAspect(draft.env))
    );
    ordered.forEach((member, index) => {
      const pos = positions[index];
      if (pos) draft.moveTo(member, pos.x, pos.y);
    });
  }
  const wrapped = wrapRect(
    draft.children(id).map((child) => draft.rect(child)),
    draft.env.frameAllowance
  );
  if (wrapped) draft.setRegion(id, { rect: wrapped });
  pushSiblings(draft, id);
  growToFit(draft, parentId);
  const where = parentId ? ` inside ${draft.name(parentId)}` : '';
  return `Grouped ${listNames(ordered.map((member) => draft.name(member)))} into ${name}${where}${renamedBecause}.`;
}

function opRename(draft: Draft, regionId: string, name: string): OpResult {
  const region = draft.regions[regionId];
  if (!region) return { error: 'That region no longer exists.' };
  const trimmed = name.trim();
  if (!trimmed) return { error: 'The new name is empty.' };
  const taken = [
    ...[...draft.windows.values()].map((window) => window.name),
    ...Object.entries(draft.regions)
      .filter(([id]) => id !== regionId)
      .map(([, other]) => other.name),
  ];
  if (taken.some((other) => nameKey(other) === nameKey(trimmed))) {
    return {
      error: `Something is already called ${trimmed}. Try "${uniqueName(trimmed, taken)}".`,
    };
  }
  const old = region.name;
  draft.setRegion(regionId, { name: trimmed, auto: false });
  draft.targets.add(regionId);
  return `Renamed ${old} to ${trimmed}.`;
}

function opDissolve(draft: Draft, regionId: string): OpResult {
  const region = draft.regions[regionId];
  if (!region) return { error: 'That region no longer exists.' };
  const parentId = draft.parent(regionId);
  const members = [
    ...Object.entries(draft.membership)
      .filter(([, owner]) => owner === regionId)
      .map(([tileId]) => tileId),
    ...childRegions(draft.state, regionId),
  ];
  const visible = draft.children(regionId);
  if (visible.length > 0) draft.forcePreview = true;
  for (const member of members) {
    draft.setParent(member, parentId);
    draft.targets.add(member);
  }
  delete draft.regions[regionId];
  // A collapsed region's space may have been used since: members keep their places, others yield.
  const pinned = new Set(members);
  for (const member of members) pushSiblings(draft, member, pinned);
  growToFit(draft, parentId);
  const count = visible.length;
  return count > 0
    ? `Dissolved ${region.name}; its ${count} window${count === 1 ? '' : 's'} stay where they are.`
    : `Removed ${region.name}.`;
}

function opCollapse(draft: Draft, regionId: string, collapsed: boolean): OpResult {
  const region = draft.regions[regionId];
  if (!region) return { error: 'That region no longer exists.' };
  draft.targets.add(regionId);
  if (region.collapsed === collapsed) {
    return `${region.name} is already ${collapsed ? 'collapsed' : 'expanded'}.`;
  }
  draft.setRegion(regionId, { collapsed });
  if (!collapsed) {
    growToFit(draft, regionId);
    pushSiblings(draft, regionId);
  }
  return `${collapsed ? 'Collapsed' : 'Expanded'} ${region.name}.`;
}

function opHideShow(draft: Draft, targets: readonly string[], hide: boolean): OpResult {
  const tiles = new Set<string>();
  for (const id of targets) {
    if (isRegionId(id)) {
      for (const tile of descendantTiles(draft.state, id))
        if (draft.present.has(tile)) tiles.add(tile);
    } else if (draft.present.has(id) && !id.startsWith('note:')) {
      tiles.add(id);
    }
  }
  const ids = [...tiles].filter((id) => draft.isHidden(id) !== hide);
  if (ids.length === 0) return hide ? 'Already closed.' : 'Already open.';
  for (const id of ids) draft.targets.add(id);
  if (hide) {
    draft.hidden = [...draft.hidden, ...ids];
  } else {
    draft.hidden = draft.hidden.filter((id) => !ids.includes(id));
    for (const id of ids) {
      const region = draft.membership[id];
      if (region && !draft.regions[region]) delete draft.membership[id];
      const before = draft.snapshot();
      settle(draft, id, before);
    }
  }
  const names = listNames(ids.map((id) => draft.name(id)));
  return hide ? `Closed ${names}.` : `Reopened ${names}.`;
}

function applyOp(draft: Draft, op: LayoutOp): OpResult {
  switch (op.op) {
    case 'move':
      return opMove(draft, op.targets, op.to);
    case 'resize':
      return opResize(draft, op.targets, op.size);
    case 'arrange':
      return opArrange(draft, op.targets, op.scope, op.layout);
    case 'organize':
      return opOrganize(draft, op.scope, op.by);
    case 'swap':
      return opSwap(draft, op.a, op.b);
    case 'createRegion':
      return opCreateRegion(draft, op);
    case 'renameRegion':
      return opRename(draft, op.region, op.name);
    case 'recolorRegion': {
      if (!draft.regions[op.region]) return { error: 'That region no longer exists.' };
      const region = draft.regions[op.region] as Mutable<RegionState>;
      const next: Mutable<RegionState> = { ...region };
      if (op.color) next.color = op.color;
      else delete next.color;
      draft.regions[op.region] = next;
      draft.targets.add(op.region);
      return `Recolored ${region.name}.`;
    }
    case 'dissolveRegion':
      return opDissolve(draft, op.region);
    case 'collapseRegion':
      return opCollapse(draft, op.region, op.collapsed);
    case 'fitRegion':
      if (!draft.regions[op.region]) return { error: 'That region no longer exists.' };
      draft.targets.add(op.region);
      wrapRegion(draft, op.region);
      return `Fitted ${draft.name(op.region)} to its windows.`;
    case 'hide':
      return opHideShow(draft, op.targets, true);
    case 'show':
      return opHideShow(draft, op.targets, false);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Plans a batch of ops against `state`. Ops run in order against the evolving draft, so "make a
 * region called Review, put Atlas in it" composes. Failed ops are reported and skipped; the batch
 * fails only when every op failed.
 */
export function planLayout(
  state: LayoutState,
  ops: readonly LayoutOp[],
  env: LayoutEnv
): PlanResult {
  if (ops.length === 0) return { ok: false, reason: 'Nothing to do.' };
  if (ops.length > MAX_OPS_PER_BATCH) {
    return { ok: false, reason: `At most ${MAX_OPS_PER_BATCH} layout changes at once.` };
  }
  const draft = new Draft(pruneLayout(state), env);
  for (const op of ops) {
    const before = draft.snapshot();
    const result = applyOp(draft, op);
    if (typeof result === 'string') {
      draft.summaries.push(result);
    } else {
      draft.restore(before);
      draft.failures.push(result.error);
    }
  }
  if (draft.summaries.length === 0) {
    return { ok: false, reason: draft.failures.join(' ') || 'Nothing changed.' };
  }
  const next = draft.snapshot();
  const touchedWindows = countTouchedWindows(state, next, draft.present);
  const displaced = [...draft.displaced].filter((id) => !draft.targets.has(id));
  const tier: LayoutTier =
    draft.forcePreview ||
    touchedWindows > PREVIEW_TOUCHED_WINDOWS ||
    displaced.length > PREVIEW_DISPLACED
      ? 'preview'
      : 'immediate';
  const pushedNote =
    displaced.length > 0
      ? ` Moved ${listNames(displaced.map((id) => draft.name(id)))} out of the way.`
      : '';
  return {
    ok: true,
    plan: {
      state: next,
      summary: `${draft.summaries.join(' ')}${pushedNote}`,
      targets: [...draft.targets].filter((id) => draft.exists(id)),
      displaced,
      created: draft.created,
      failures: draft.failures,
      tier,
      touchedWindows,
    },
  };
}

/** Drops membership and region parents that point at regions that no longer exist. */
export function pruneLayout(state: LayoutState): LayoutState {
  let changed = false;
  const membership: Record<string, string> = {};
  for (const [tileId, regionId] of Object.entries(state.membership)) {
    if (state.regions[regionId]) membership[tileId] = regionId;
    else changed = true;
  }
  const regions: Record<string, RegionState> = {};
  for (const [id, region] of Object.entries(state.regions)) {
    if (region.parentId && !state.regions[region.parentId]) {
      regions[id] = { ...region, parentId: null };
      changed = true;
    } else {
      regions[id] = region;
    }
  }
  return changed ? { ...state, membership, regions } : state;
}

function countTouchedWindows(
  before: LayoutState,
  after: LayoutState,
  present: ReadonlySet<string>
): number {
  let count = 0;
  const hiddenBefore = new Set(before.hidden);
  const hiddenAfter = new Set(after.hidden);
  for (const id of present) {
    const a = before.tiles[id];
    const b = after.tiles[id];
    const moved = !a || !b ? a !== b : a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
    if (
      moved ||
      before.membership[id] !== after.membership[id] ||
      hiddenBefore.has(id) !== hiddenAfter.has(id)
    ) {
      count++;
    }
  }
  return count;
}

/** Deepest visible region whose content area contains `point` (for pointer drops). */
export function regionAt(
  state: LayoutState,
  point: { x: number; y: number },
  exclude?: string
): string | null {
  let best: { id: string; depth: number } | null = null;
  for (const [id, region] of Object.entries(state.regions)) {
    if (region.collapsed) continue;
    if (exclude && (id === exclude || isWithinState(state, id, exclude))) continue;
    if (collapsedAncestor(state, id)) continue;
    const rect = region.rect;
    if (
      point.x < rect.x ||
      point.y < rect.y ||
      point.x > rect.x + rect.w ||
      point.y > rect.y + rect.h
    ) {
      continue;
    }
    const depth = regionDepth(state, id);
    if (!best || depth > best.depth) best = { id, depth };
  }
  return best?.id ?? null;
}

function isWithinState(state: LayoutState, id: string, ancestor: string): boolean {
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentOf(state, current);
  }
  return false;
}

function collapsedAncestor(state: LayoutState, id: string): boolean {
  let current = parentOf(state, id);
  while (current) {
    if (state.regions[current]?.collapsed) return true;
    current = parentOf(state, current);
  }
  return false;
}
