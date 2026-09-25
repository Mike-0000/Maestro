/**
 * Regions: named, nestable rectangles on the one canvas with explicit membership.
 *
 * Everything here is pure. A `LayoutState` is the undoable part of the board (tile geometry,
 * regions, membership, hidden windows); the planner in `canvas-layout.ts` turns operations into a
 * new `LayoutState`, and `canvas-history.ts` records the difference.
 */

import {
  AGENT_TILE_SIZE,
  BROWSER_TILE_SIZE,
  boundsOf,
  FRAME_HEADER,
  FRAME_PADDING,
  NOTE_TILE_SIZE,
  type TileRect,
} from './canvas-model';

export const REGION_COLORS = ['blue', 'violet', 'green', 'amber', 'rose', 'teal', 'gray'] as const;
export type RegionColor = (typeof REGION_COLORS)[number];

export type RegionState = {
  readonly name: string;
  /** Parent region id, or null for the board root. */
  readonly parentId: string | null;
  readonly rect: TileRect;
  /** Folded to its header chip; members keep their rects and stay addressable. */
  readonly collapsed: boolean;
  readonly color?: RegionColor;
  readonly createdAt: number;
  /** Created by "organize"; a later organize may regroup its windows. */
  readonly auto?: boolean;
};

export type LayoutState = {
  /** Geometry by tile id. */
  readonly tiles: Readonly<Record<string, TileRect>>;
  readonly regions: Readonly<Record<string, RegionState>>;
  /** Region of each tile that is not at the board root. */
  readonly membership: Readonly<Record<string, string>>;
  /** Tile ids closed by the user (their agents keep running). */
  readonly hidden: readonly string[];
};

export const EMPTY_LAYOUT: LayoutState = { tiles: {}, regions: {}, membership: {}, hidden: [] };

export type WindowKind = 'agent' | 'browser' | 'note';

/** Coarse status used for grouping and summaries. */
export type WindowStatus = 'needs-you' | 'working' | 'idle' | 'done' | 'error';

/** What the planner knows about a window that exists right now. */
export type LayoutWindow = {
  readonly tileId: string;
  readonly kind: WindowKind;
  readonly name: string;
  readonly taskId?: string;
  readonly taskName?: string;
  readonly projectName?: string;
  readonly providerLabel?: string;
  readonly status?: WindowStatus;
};

/** Board grid (matches the dot background). */
export const GRID = 24;
/** Nesting cap: deeper trees are hard to address by voice and stacked headers eat space. */
export const MAX_REGION_DEPTH = 3;
export const REGION_HEADER = 40;
export const REGION_PADDING = 24;
/** Height of a collapsed region's chip. */
export const COLLAPSED_REGION_HEIGHT = 56;
export const MIN_REGION_SIZE = { w: 320, h: 160 } as const;

export function isRegionId(id: string): boolean {
  return id.startsWith('region:');
}

export function newRegionId(uuid: string): string {
  return `region:${uuid}`;
}

export function windowKindOf(tileId: string): WindowKind {
  if (tileId.startsWith('note:')) return 'note';
  if (tileId.startsWith('browser:')) return 'browser';
  return 'agent';
}

export function defaultSizeOf(tileId: string): { w: number; h: number } {
  switch (windowKindOf(tileId)) {
    case 'note':
      return NOTE_TILE_SIZE;
    case 'browser':
      return BROWSER_TILE_SIZE;
    default:
      return AGENT_TILE_SIZE;
  }
}

export function minSizeOf(tileId: string): { w: number; h: number } {
  switch (windowKindOf(tileId)) {
    case 'note':
      return { w: 200, h: 120 };
    case 'browser':
      return { w: 480, h: 320 };
    default:
      return { w: 360, h: 220 };
  }
}

export function tileRectOf(state: LayoutState, tileId: string): TileRect {
  return state.tiles[tileId] ?? { x: 0, y: 0, ...defaultSizeOf(tileId) };
}

// ── Tree queries ─────────────────────────────────────────────────────────────

/** The region a tile or region sits in, or null at the root (dangling ids count as root). */
export function parentOf(state: LayoutState, id: string): string | null {
  if (isRegionId(id)) {
    const parent = state.regions[id]?.parentId ?? null;
    return parent && state.regions[parent] ? parent : null;
  }
  const region = state.membership[id];
  return region && state.regions[region] ? region : null;
}

/** Region ids from the root down to `regionId` (inclusive). */
export function regionPath(state: LayoutState, regionId: string | null): string[] {
  const path: string[] = [];
  let current = regionId;
  const seen = new Set<string>();
  while (current && state.regions[current] && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = state.regions[current]?.parentId ?? null;
  }
  return path;
}

/** 1 for a region at the root. */
export function regionDepth(state: LayoutState, regionId: string): number {
  return regionPath(state, regionId).length;
}

export function childRegions(state: LayoutState, parentId: string | null): string[] {
  return Object.keys(state.regions)
    .filter((id) => parentOf(state, id) === parentId)
    .sort();
}

/** Direct window children (only windows that exist, per `present`). */
export function childTiles(
  state: LayoutState,
  parentId: string | null,
  present: ReadonlySet<string>
): string[] {
  const hidden = new Set(state.hidden);
  return [...present].filter((id) => !hidden.has(id) && parentOf(state, id) === parentId).sort();
}

/** Every region nested under `regionId` (not including it). */
export function descendantRegions(state: LayoutState, regionId: string): string[] {
  const out: string[] = [];
  const queue = [regionId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childRegions(state, current)) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Depth of the region subtree rooted at `regionId` (1 when it has no child regions). */
export function subtreeHeight(state: LayoutState, regionId: string): number {
  const children = childRegions(state, regionId);
  return 1 + Math.max(0, ...children.map((child) => subtreeHeight(state, child)));
}

/** Tile ids anywhere under a region, hidden or not (they move with it). */
export function descendantTiles(state: LayoutState, regionId: string): string[] {
  const regions = new Set([regionId, ...descendantRegions(state, regionId)]);
  return Object.entries(state.membership)
    .filter(([, region]) => regions.has(region))
    .map(([tileId]) => tileId)
    .sort();
}

/** True when `ancestor` is `id` or contains it. */
export function isWithin(state: LayoutState, id: string, ancestor: string): boolean {
  if (id === ancestor) return true;
  let current = parentOf(state, id);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentOf(state, current);
  }
  return false;
}

/** True when a region or any of its ancestors is collapsed (its members are not drawn). */
export function isFoldedAway(state: LayoutState, id: string): boolean {
  let current = parentOf(state, id);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (state.regions[current]?.collapsed) return true;
    seen.add(current);
    current = parentOf(state, current);
  }
  return false;
}

/** A region's rect as it occupies space (collapsed regions are just their chip). */
export function regionFootprint(region: RegionState): TileRect {
  return region.collapsed ? { ...region.rect, h: COLLAPSED_REGION_HEIGHT } : region.rect;
}

/** Rect of a board node: a window or a region. */
export function nodeRect(state: LayoutState, id: string): TileRect {
  if (isRegionId(id)) {
    const region = state.regions[id];
    return region ? regionFootprint(region) : { x: 0, y: 0, w: 0, h: 0 };
  }
  return tileRectOf(state, id);
}

/** Insets from a region's edge to where its members go. */
export function regionInsets(frameAllowance: number): {
  top: number;
  side: number;
  bottom: number;
} {
  return {
    top: REGION_HEADER + REGION_PADDING / 2 + frameAllowance,
    side: REGION_PADDING + (frameAllowance > 0 ? FRAME_PADDING : 0),
    bottom: REGION_PADDING + (frameAllowance > 0 ? FRAME_PADDING : 0),
  };
}

/** Space a task frame needs above its tiles (0 when frames are off). */
export function frameAllowanceFor(showTaskFrames: boolean): number {
  return showTaskFrames ? FRAME_HEADER + FRAME_PADDING : 0;
}

export function contentBox(region: RegionState, frameAllowance: number): TileRect {
  const insets = regionInsets(frameAllowance);
  return {
    x: region.rect.x + insets.side,
    y: region.rect.y + insets.top,
    w: Math.max(0, region.rect.w - insets.side * 2),
    h: Math.max(0, region.rect.h - insets.top - insets.bottom),
  };
}

/** The smallest region rect that holds `rects` (member footprints) with its insets. */
export function wrapRect(rects: readonly TileRect[], frameAllowance: number): TileRect | null {
  const bounds = boundsOf(rects);
  if (!bounds) return null;
  const insets = regionInsets(frameAllowance);
  return {
    x: bounds.x - insets.side,
    y: bounds.y - insets.top,
    w: Math.max(MIN_REGION_SIZE.w, bounds.w + insets.side * 2),
    h: Math.max(MIN_REGION_SIZE.h, bounds.h + insets.top + insets.bottom),
  };
}

/** Status summary for a region header: "2 working · 1 needs you". */
export function statusSummary(statuses: readonly (WindowStatus | undefined)[]): string {
  const counts = new Map<WindowStatus, number>();
  for (const status of statuses) if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
  const order: [WindowStatus, string][] = [
    ['needs-you', 'need you'],
    ['error', 'failed'],
    ['working', 'working'],
    ['done', 'done'],
  ];
  return order
    .filter(([status]) => counts.has(status))
    .map(([status, label]) => {
      const count = counts.get(status) ?? 0;
      return `${count} ${status === 'needs-you' && count === 1 ? 'needs you' : label}`;
    })
    .join(' · ');
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * Names for unnamed regions. Chosen to sound unlike the agent roster (Atlas, Bravo, ...) and each
 * other, so "move Cedar into Summit" is never ambiguous; a unit test checks this.
 */
export const REGION_NAME_ROSTER = [
  'Summit',
  'Meadow',
  'Lantern',
  'Lagoon',
  'Orchard',
  'Prairie',
  'Tundra',
  'Glacier',
  'Bayou',
  'Mesa',
  'Fjord',
  'Grove',
] as const;

/** Normalized form for name comparisons. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** First roster name nobody uses, else "Region N". */
export function nextRegionName(taken: Iterable<string>): string {
  const used = new Set([...taken].map(nameKey));
  for (const name of REGION_NAME_ROSTER) if (!used.has(nameKey(name))) return name;
  let n = 2;
  while (used.has(nameKey(`Region ${n}`))) n++;
  return `Region ${n}`;
}

/** `preferred`, or "<preferred> group", "<preferred> 2", ... when it is taken. */
export function uniqueName(preferred: string, taken: Iterable<string>): string {
  const base = preferred.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Region';
  const used = new Set([...taken].map(nameKey));
  if (!used.has(nameKey(base))) return base;
  if (!used.has(nameKey(`${base} group`))) return `${base} group`;
  let n = 2;
  while (used.has(nameKey(`${base} ${n}`))) n++;
  return `${base} ${n}`;
}

/** Region id by (case-insensitive) name. */
export function regionByName(state: LayoutState, name: string): string | null {
  const key = nameKey(name);
  for (const [id, region] of Object.entries(state.regions)) {
    if (nameKey(region.name) === key) return id;
  }
  return null;
}

/** Colors for status groups (organize by status). */
export const STATUS_GROUPS: readonly {
  status: WindowStatus;
  label: string;
  color: RegionColor;
}[] = [
  { status: 'needs-you', label: 'Needs you', color: 'amber' },
  { status: 'error', label: 'Failed', color: 'rose' },
  { status: 'working', label: 'Working', color: 'blue' },
  { status: 'idle', label: 'Idle', color: 'gray' },
  { status: 'done', label: 'Done', color: 'green' },
];
