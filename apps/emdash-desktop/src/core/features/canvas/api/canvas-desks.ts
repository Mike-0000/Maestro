/**
 * Canvas Pro: desks. A desk is a top-level region shown alone; the user swaps between desks rather
 * than travelling across one board. Because only one desk shows at a time, a window can also
 * *visit* the desk in view without leaving its own: visitors are drawn there from a layout worked
 * out here and never written to the board. Pure.
 */

import type { LayoutOp } from './canvas-layout';
import type { TileRect } from './canvas-model';
import {
  childRegions,
  GRID,
  isRegionId,
  nameKey,
  parentOf,
  type LayoutState,
  type LayoutWindow,
  type WindowStatus,
} from './canvas-regions';
import { tilingColumns } from './region-tiling';

export type CanvasMode = 'classic' | 'pro';

/** The desk loose windows are gathered into when the canvas switches to Pro. */
export const MAIN_DESK_NAME = 'Main';

/** Statuses a gathering desk can collect, with the words for them. */
export const GATHER_LABELS: Record<WindowStatus, string> = {
  'needs-you': 'needs you',
  error: 'failed',
  working: 'working',
  done: 'done',
  idle: 'idle',
};

/** The same, of several agents: "agents that need you". */
export const GATHER_PHRASES: Record<WindowStatus, string> = {
  'needs-you': 'need you',
  error: 'failed',
  working: 'are working',
  done: 'are done',
  idle: 'are idle',
};

/** Desks in order: by `order` where set, then by age. */
export function deskIds(state: LayoutState): string[] {
  const rank = (id: string) => state.regions[id]?.order ?? Number.MAX_SAFE_INTEGER;
  const age = (id: string) => state.regions[id]?.createdAt ?? 0;
  return childRegions(state, null).sort(
    (a, b) => rank(a) - rank(b) || age(a) - age(b) || a.localeCompare(b)
  );
}

/** The desk a window or region is on (a desk is on itself); null for a loose window. */
export function deskOf(state: LayoutState, id: string | null): string | null {
  if (!id) return null;
  let current: string | null = isRegionId(id)
    ? state.regions[id]
      ? id
      : null
    : parentOf(state, id);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = parentOf(state, current);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

/** The next (1) or previous (-1) desk in order, wrapping; null when there is no other desk. */
export function adjacentDesk(
  state: LayoutState,
  deskId: string | null,
  step: 1 | -1
): string | null {
  const desks = deskIds(state);
  if (desks.length === 0) return null;
  if (!deskId) return (step === 1 ? desks[0] : desks.at(-1)) ?? null;
  const index = desks.indexOf(deskId);
  if (index === -1 || desks.length === 1) return null;
  return desks[(index + step + desks.length) % desks.length] ?? null;
}

/** Where a desk goes: an end, one place over, or a 1-based position. */
export type DeskPosition = 'first' | 'last' | 'left' | 'right' | number;

/** `desks` with `deskId` moved to `position`; null when it is not a desk. */
export function reorderDesks(
  desks: readonly string[],
  deskId: string,
  position: DeskPosition
): string[] | null {
  const from = desks.indexOf(deskId);
  if (from === -1) return null;
  const last = desks.length - 1;
  const wanted =
    position === 'first'
      ? 0
      : position === 'last'
        ? last
        : position === 'left'
          ? from - 1
          : position === 'right'
            ? from + 1
            : Math.round(position) - 1;
  const to = Math.min(last, Math.max(0, Number.isFinite(wanted) ? wanted : from));
  const next = desks.filter((id) => id !== deskId);
  next.splice(to, 0, deskId);
  return next;
}

/** Windows that exist but are on no desk (at the board root). */
export function looseWindows(state: LayoutState, present: Iterable<string>): string[] {
  return [...present].filter((id) => !isRegionId(id) && parentOf(state, id) === null).sort();
}

/** The desk called "Main", if there is one. */
export function mainDeskId(state: LayoutState): string | null {
  const key = nameKey(MAIN_DESK_NAME);
  return deskIds(state).find((id) => nameKey(state.regions[id]?.name ?? '') === key) ?? null;
}

/**
 * A project's desk: a desk tagged with the project, else one named after it that no other project
 * claims. Gathering desks are never anyone's. Unlike a project's sub-canvas on the classic board, a
 * desk the developer named after the project counts: on Pro that is how they say it is its desk.
 */
export function projectDeskId(
  state: LayoutState,
  projectId: string,
  projectName: string
): string | null {
  const desks = deskIds(state).filter((id) => !state.regions[id]?.gather);
  if (projectId) {
    const tagged = desks.find((id) => state.regions[id]?.projectId === projectId);
    if (tagged) return tagged;
  }
  const key = nameKey(projectName);
  if (!key) return null;
  return (
    desks.find((id) => {
      const region = state.regions[id];
      return region && !region.projectId && nameKey(region.name) === key;
    }) ?? null
  );
}

/**
 * Ops that leave every window on a desk: loose ones go to `preferred`, else to Main (made when
 * missing). With no desk at all an empty Main is made, so there is always somewhere to be.
 */
export function homeLooseOps(
  state: LayoutState,
  present: Iterable<string>,
  preferred: string | null = null
): LayoutOp[] {
  const loose = looseWindows(state, present);
  const home = preferred && state.regions[preferred] ? deskOf(state, preferred) : mainDeskId(state);
  if (loose.length === 0) {
    return deskIds(state).length > 0
      ? []
      : [{ op: 'createRegion', name: MAIN_DESK_NAME, members: [], parent: null }];
  }
  if (home) return [{ op: 'move', targets: loose, to: { kind: 'region', region: home } }];
  return [{ op: 'createRegion', name: MAIN_DESK_NAME, members: loose, parent: null }];
}

/** Which desk a removed desk's windows go to: the named one, else the one before it in order. */
export function deskHeir(state: LayoutState, deskId: string, into?: string | null): string | null {
  if (into && into !== deskId && state.regions[into]) return deskOf(state, into);
  const desks = deskIds(state);
  if (desks.length < 2) return null;
  const index = desks.indexOf(deskId);
  if (index === -1) return null;
  return desks[index === 0 ? 1 : index - 1] ?? null;
}

/** Ops that remove a desk, sending its windows to its heir; the last desk stays. */
export function removeDeskOps(
  state: LayoutState,
  deskId: string,
  into?: string | null
): { ops: LayoutOp[]; heir: string } | { error: string } {
  if (!state.regions[deskId] || parentOf(state, deskId)) return { error: 'That is not a desk.' };
  if (deskIds(state).length < 2) {
    return { error: 'That is the only desk. Make another one first.' };
  }
  const heir = deskHeir(state, deskId, into);
  if (!heir) return { error: 'There is no desk to move its windows to.' };
  return { ops: [{ op: 'dissolveRegion', region: deskId, into: heir }], heir };
}

/** `state` with every desk numbered: `first` in that order, then the rest as they were. */
export function stampDeskOrder(state: LayoutState, first: readonly string[]): LayoutState {
  const desks = deskIds(state);
  const led = first.filter((id) => desks.includes(id));
  const order = [...led, ...desks.filter((id) => !led.includes(id))];
  const regions = { ...state.regions };
  order.forEach((id, index) => {
    const region = regions[id];
    if (region && region.order !== index) regions[id] = { ...region, order: index };
  });
  return { ...state, regions };
}

// ── Signals ──────────────────────────────────────────────────────────────────

export type DeskSummary = {
  readonly regionId: string;
  readonly name: string;
  readonly waiting: number;
  readonly failed: number;
};

/** A desk out of view that wants the user, and the screen edge it lies toward. */
export type DeskSignal = DeskSummary & { readonly side: 'left' | 'right' };

/**
 * Desks other than the one in view with agents waiting or failed, each on the side its place in
 * the order lies: the edge of the screen points at the work that needs the user.
 */
export function deskSignals(desks: readonly DeskSummary[], activeId: string | null): DeskSignal[] {
  const active = desks.findIndex((desk) => desk.regionId === activeId);
  return desks.flatMap((desk, index) => {
    if (index === active || desk.waiting + desk.failed === 0) return [];
    return [{ ...desk, side: active !== -1 && index < active ? 'left' : 'right' } as const];
  });
}

// ── Visitors ─────────────────────────────────────────────────────────────────

/** Windows a gathering desk collects right now: those with `status` that live on another desk. */
export function gatherMatches(
  state: LayoutState,
  windows: readonly LayoutWindow[],
  deskId: string,
  status: WindowStatus,
  visible: ReadonlySet<string>
): string[] {
  return windows
    .filter(
      (window) =>
        window.status === status &&
        visible.has(window.tileId) &&
        deskOf(state, window.tileId) !== deskId
    )
    .map((window) => window.tileId)
    .sort();
}

/** Share of the desk a floating group of visitors takes (the desk's own windows stay behind). */
const VISITOR_FLOAT = 0.78;

/**
 * Where visitors are drawn on the desk in view: tiled across the whole desk when it has no windows
 * of its own (a gathering desk), else as a group floating above them.
 */
export function visitorLayout(
  content: TileRect,
  visitors: readonly string[],
  floating: boolean,
  gap: number = GRID
): Map<string, TileRect> {
  const out = new Map<string, TileRect>();
  if (visitors.length === 0 || content.w <= 0 || content.h <= 0) return out;
  const share = floating ? VISITOR_FLOAT : 1;
  const box = {
    x: content.x + (content.w * (1 - share)) / 2,
    y: content.y + (content.h * (1 - share)) / 2,
    w: content.w * share,
    h: content.h * share,
  };
  // An even grid that never leaves the desk: with many visitors the panes get smaller instead
  // (a region's tiling would grow past the screen, where a locked desk cannot follow).
  const columns = Math.min(visitors.length, tilingColumns(visitors.length, box.w / box.h));
  const rows = Math.ceil(visitors.length / columns);
  const height = (box.h - gap * (rows - 1)) / rows;
  for (let row = 0; row < rows; row++) {
    const inRow = visitors.slice(row * columns, (row + 1) * columns);
    // A short last row shares the full width.
    const width = (box.w - gap * (inRow.length - 1)) / inRow.length;
    inRow.forEach((id, column) => {
      const x = Math.round(box.x + column * (width + gap));
      const y = Math.round(box.y + row * (height + gap));
      out.set(id, { x, y, w: Math.floor(width), h: Math.floor(height) });
    });
  }
  return out;
}
