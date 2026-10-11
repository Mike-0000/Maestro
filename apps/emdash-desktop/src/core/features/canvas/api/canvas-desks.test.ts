import { describe, expect, it } from 'vitest';
import {
  adjacentDesk,
  deskHeir,
  deskIds,
  deskOf,
  deskSignals,
  gatherMatches,
  homeLooseOps,
  looseWindows,
  mainDeskId,
  removeDeskOps,
  reorderDesks,
  stampDeskOrder,
  visitorLayout,
} from './canvas-desks';
import { planLayout, type LayoutEnv, type LayoutOp } from './canvas-layout';
import { rectContains, rectsOverlap, type TileRect } from './canvas-model';
import {
  EMPTY_LAYOUT,
  minSizeOf,
  parentOf,
  type LayoutState,
  type LayoutWindow,
  type RegionState,
  type WindowStatus,
} from './canvas-regions';

const RECT: TileRect = { x: 0, y: 0, w: 1568, h: 828 };

function region(name: string, patch: Partial<RegionState> = {}): RegionState {
  return { name, parentId: null, rect: RECT, collapsed: false, createdAt: 1, ...patch };
}

function agent(name: string, status: WindowStatus = 'working'): LayoutWindow {
  return { tileId: `agent:${name.toLowerCase()}`, kind: 'agent', name, status };
}

function env(windows: LayoutWindow[]): LayoutEnv {
  let n = 0;
  return {
    windows,
    screen: { width: 1600, height: 900 },
    viewport: { x: 0, y: 0, zoom: 1 },
    frameAllowance: 0,
    now: 10,
    newId: () => `new${n++}`,
  };
}

function plan(state: LayoutState, ops: LayoutOp[], e: LayoutEnv) {
  const result = planLayout(state, ops, e);
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

/** Three desks (b, a, c by age) with a region nested in the second. */
const THREE: LayoutState = {
  ...EMPTY_LAYOUT,
  regions: {
    'region:a': region('Alpha', { createdAt: 2 }),
    'region:b': region('Beta', { createdAt: 1 }),
    'region:c': region('Gamma', { createdAt: 3 }),
    'region:inner': region('Inner', { parentId: 'region:a', createdAt: 4 }),
  },
  membership: { 'agent:atlas': 'region:a', 'agent:bravo': 'region:inner' },
};

describe('desk order', () => {
  it('lists top-level regions by age when none is ordered', () => {
    expect(deskIds(THREE)).toEqual(['region:b', 'region:a', 'region:c']);
  });

  it('puts ordered desks first, in their order', () => {
    const state = stampDeskOrder(THREE, ['region:c', 'region:a']);
    expect(deskIds(state)).toEqual(['region:c', 'region:a', 'region:b']);
    expect(state.regions['region:inner']?.order).toBeUndefined();
  });

  it('steps to the next and previous desk, wrapping', () => {
    expect(adjacentDesk(THREE, 'region:b', 1)).toBe('region:a');
    expect(adjacentDesk(THREE, 'region:b', -1)).toBe('region:c');
    expect(adjacentDesk(THREE, 'region:c', 1)).toBe('region:b');
    expect(adjacentDesk(THREE, null, 1)).toBe('region:b');
  });

  it('has no adjacent desk when there is only one', () => {
    const one = { ...EMPTY_LAYOUT, regions: { 'region:a': region('Alpha') } };
    expect(adjacentDesk(one, 'region:a', 1)).toBeNull();
    expect(adjacentDesk(EMPTY_LAYOUT, null, 1)).toBeNull();
  });

  it('moves a desk to an end, one place over, or a numbered place', () => {
    const desks = ['a', 'b', 'c', 'd'];
    expect(reorderDesks(desks, 'c', 'first')).toEqual(['c', 'a', 'b', 'd']);
    expect(reorderDesks(desks, 'a', 'last')).toEqual(['b', 'c', 'd', 'a']);
    expect(reorderDesks(desks, 'c', 'left')).toEqual(['a', 'c', 'b', 'd']);
    expect(reorderDesks(desks, 'c', 'right')).toEqual(['a', 'b', 'd', 'c']);
    expect(reorderDesks(desks, 'd', 2)).toEqual(['a', 'd', 'b', 'c']);
    expect(reorderDesks(desks, 'a', 'left')).toEqual(desks);
    expect(reorderDesks(desks, 'd', 99)).toEqual(desks);
    expect(reorderDesks(desks, 'x', 'first')).toBeNull();
  });
});

describe('deskOf', () => {
  it('finds the desk of a window, a nested region, and a desk itself', () => {
    expect(deskOf(THREE, 'agent:atlas')).toBe('region:a');
    expect(deskOf(THREE, 'agent:bravo')).toBe('region:a');
    expect(deskOf(THREE, 'region:inner')).toBe('region:a');
    expect(deskOf(THREE, 'region:c')).toBe('region:c');
  });

  it('is null for loose windows, unknown regions, and nothing', () => {
    expect(deskOf(THREE, 'agent:loose')).toBeNull();
    expect(deskOf(THREE, 'region:gone')).toBeNull();
    expect(deskOf(THREE, null)).toBeNull();
  });
});

describe('homing loose windows', () => {
  const windows = [agent('Atlas'), agent('Bravo'), agent('Cedar')];
  const present = windows.map((window) => window.tileId);

  it('makes Main for loose windows when there is no desk to take them', () => {
    const ops = homeLooseOps(EMPTY_LAYOUT, present);
    expect(ops).toEqual([{ op: 'createRegion', name: 'Main', members: present, parent: null }]);
    const next = plan(EMPTY_LAYOUT, ops, env(windows)).state;
    expect(looseWindows(next, present)).toEqual([]);
    const main = mainDeskId(next);
    expect(main).not.toBeNull();
    // A desk is a workspace: tiled, and sized to the screen so it frames at zoom 1.
    const desk = next.regions[main as string] as RegionState;
    expect(desk.arrangement).toBe('tiled');
    expect({ w: desk.rect.w, h: desk.rect.h }).toEqual({ w: 1568, h: 828 });
  });

  it('sends loose windows to the preferred desk, else to an existing Main', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: { 'region:m': region('Main'), 'region:r': region('Review', { createdAt: 2 }) },
      membership: { 'agent:atlas': 'region:r' },
    };
    const loose = ['agent:bravo', 'agent:cedar'];
    expect(homeLooseOps(state, present)).toEqual([
      { op: 'move', targets: loose, to: { kind: 'region', region: 'region:m' } },
    ]);
    expect(homeLooseOps(state, present, 'region:r')).toEqual([
      { op: 'move', targets: loose, to: { kind: 'region', region: 'region:r' } },
    ]);
  });

  it('does nothing when every window is on a desk, and makes an empty Main when there is none', () => {
    const state: LayoutState = {
      ...EMPTY_LAYOUT,
      regions: { 'region:r': region('Review') },
      membership: Object.fromEntries(present.map((id) => [id, 'region:r'])),
    };
    expect(homeLooseOps(state, present)).toEqual([]);
    expect(homeLooseOps(EMPTY_LAYOUT, [])).toEqual([
      { op: 'createRegion', name: 'Main', members: [], parent: null },
    ]);
  });
});

describe('removing a desk', () => {
  it('sends its windows to the desk before it, or to the one named', () => {
    expect(deskHeir(THREE, 'region:a')).toBe('region:b');
    expect(deskHeir(THREE, 'region:b')).toBe('region:a');
    expect(deskHeir(THREE, 'region:a', 'region:c')).toBe('region:c');
    // A region inside a desk names its desk.
    expect(deskHeir(THREE, 'region:c', 'region:inner')).toBe('region:a');
  });

  it('refuses the last desk and things that are not desks', () => {
    const one = { ...EMPTY_LAYOUT, regions: { 'region:a': region('Alpha') } };
    expect(removeDeskOps(one, 'region:a')).toEqual({
      error: 'That is the only desk. Make another one first.',
    });
    expect(removeDeskOps(THREE, 'region:inner')).toEqual({ error: 'That is not a desk.' });
    expect(removeDeskOps(THREE, 'region:gone')).toEqual({ error: 'That is not a desk.' });
  });

  it('moves the windows and nested regions to the heir as a previewed change', () => {
    const windows = [agent('Atlas'), agent('Bravo'), agent('Cedar')];
    const e = env(windows);
    const made = plan(
      EMPTY_LAYOUT,
      [
        { op: 'createRegion', name: 'One', members: ['agent:atlas', 'agent:bravo'], parent: null },
        { op: 'createRegion', name: 'Two', members: ['agent:cedar'], parent: null },
      ],
      e
    );
    const [one, two] = made.created as [string, string];
    const removal = removeDeskOps(made.state, one);
    if ('error' in removal) throw new Error(removal.error);
    expect(removal.heir).toBe(two);
    const after = plan(made.state, removal.ops, e);
    expect(after.tier).toBe('preview');
    expect(after.state.regions[one]).toBeUndefined();
    for (const window of windows) expect(parentOf(after.state, window.tileId)).toBe(two);
    // The heir is tiled, so all three now share it without overlap.
    const rects = windows.map((window) => after.state.tiles[window.tileId] as TileRect);
    const desk = (after.state.regions[two] as RegionState).rect;
    for (const rect of rects) expect(rectContains(desk, rect)).toBe(true);
    expect(rectsOverlap(rects[0] as TileRect, rects[1] as TileRect)).toBe(false);
    expect(rectsOverlap(rects[1] as TileRect, rects[2] as TileRect)).toBe(false);
  });
});

describe('planner desk ops', () => {
  it('reorders desks and numbers every one', () => {
    const next = plan(
      THREE,
      [{ op: 'reorderDesk', region: 'region:c', position: 'first' }],
      env([])
    );
    expect(deskIds(next.state)).toEqual(['region:c', 'region:b', 'region:a']);
    expect(next.summary).toBe('Gamma is now desk 1 of 3.');
    expect(Object.values(next.state.regions).filter((r) => r.order !== undefined)).toHaveLength(3);
  });

  it('refuses to reorder a region inside a desk', () => {
    const result = planLayout(
      THREE,
      [{ op: 'reorderDesk', region: 'region:inner', position: 'first' }],
      env([])
    );
    expect(result).toEqual({ ok: false, reason: 'That is not a desk.' });
  });

  it('gives a new desk the last place where desks are ordered', () => {
    const create: LayoutOp = { op: 'createRegion', name: 'New', members: [], parent: null };
    const ordered = stampDeskOrder(THREE, ['region:c', 'region:a', 'region:b']);
    const next = plan(ordered, [create], env([]));
    const [id] = next.created as [string];
    expect(deskIds(next.state)).toEqual(['region:c', 'region:a', 'region:b', id]);
    // A board whose regions were never ordered stays that way.
    const plain = plan(THREE, [create], env([]));
    expect(plain.state.regions[plain.created[0] as string]?.order).toBeUndefined();
  });

  it('makes a gathering desk', () => {
    const next = plan(
      EMPTY_LAYOUT,
      [{ op: 'createRegion', name: 'Triage', members: [], parent: null, gather: 'needs-you' }],
      env([])
    );
    const [id] = next.created as [string];
    expect(next.state.regions[id]?.gather).toBe('needs-you');
  });
});

describe('signals', () => {
  const desk = (regionId: string, waiting: number, failed = 0) => ({
    regionId,
    name: regionId,
    waiting,
    failed,
  });

  it('points at desks that need the user, by the side they lie on', () => {
    const desks = [desk('a', 1), desk('b', 0), desk('c', 0), desk('d', 0, 2), desk('e', 0)];
    expect(deskSignals(desks, 'c')).toEqual([
      { ...desk('a', 1), side: 'left' },
      { ...desk('d', 0, 2), side: 'right' },
    ]);
  });

  it('never signals the desk in view', () => {
    expect(deskSignals([desk('a', 3), desk('b', 0)], 'a')).toEqual([]);
  });
});

describe('visitors', () => {
  const windows = [
    agent('Atlas', 'needs-you'),
    agent('Bravo', 'working'),
    agent('Cedar', 'needs-you'),
  ];
  const state: LayoutState = {
    ...EMPTY_LAYOUT,
    regions: {
      'region:t': region('Triage', { gather: 'needs-you' }),
      'region:r': region('Review', { createdAt: 2 }),
    },
    membership: {
      'agent:atlas': 'region:r',
      'agent:bravo': 'region:r',
      'agent:cedar': 'region:t',
    },
  };

  it('gathers the windows with the status that live on other desks', () => {
    const visible = new Set(windows.map((window) => window.tileId));
    expect(gatherMatches(state, windows, 'region:t', 'needs-you', visible)).toEqual([
      'agent:atlas',
    ]);
    // A closed window is not gathered.
    expect(gatherMatches(state, windows, 'region:t', 'needs-you', new Set())).toEqual([]);
  });

  it('tiles visitors across an empty desk, inside it and at least their minimum size', () => {
    const ids = ['agent:atlas', 'agent:bravo', 'agent:cedar'];
    const rects = visitorLayout(RECT, ids, false);
    expect([...rects.keys()].sort()).toEqual(ids);
    for (const id of ids) {
      const rect = rects.get(id) as TileRect;
      expect(rectContains(RECT, rect)).toBe(true);
      expect(rect.w).toBeGreaterThanOrEqual(minSizeOf(id).w);
      expect(rect.h).toBeGreaterThanOrEqual(minSizeOf(id).h);
    }
    const [a, b, c] = ids.map((id) => rects.get(id) as TileRect) as [TileRect, TileRect, TileRect];
    expect(rectsOverlap(a, b) || rectsOverlap(b, c) || rectsOverlap(a, c)).toBe(false);
  });

  it('floats visitors in the middle of a desk that has its own windows', () => {
    const rect = visitorLayout(RECT, ['agent:atlas'], true).get('agent:atlas') as TileRect;
    expect(rect.w).toBeLessThan(RECT.w);
    expect(rect.h).toBeLessThan(RECT.h);
    expect(Math.abs(rect.x + rect.w / 2 - (RECT.x + RECT.w / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y + rect.h / 2 - (RECT.y + RECT.h / 2))).toBeLessThanOrEqual(1);
  });

  it('keeps any number of visitors inside the desk, without overlap', () => {
    for (const floating of [false, true]) {
      for (const count of [1, 2, 5, 7, 8, 10, 11, 13, 16, 24]) {
        const ids = Array.from({ length: count }, (_, i) => `agent:v${String(i).padStart(2, '0')}`);
        const rects = [...visitorLayout(RECT, ids, floating).values()];
        expect(rects).toHaveLength(count);
        for (const rect of rects) expect(rectContains(RECT, rect)).toBe(true);
        for (let a = 0; a < rects.length; a++) {
          for (let b = a + 1; b < rects.length; b++) {
            expect(rectsOverlap(rects[a] as TileRect, rects[b] as TileRect)).toBe(false);
          }
        }
      }
    }
  });

  it('draws nobody when there are no visitors', () => {
    expect(visitorLayout(RECT, [], true).size).toBe(0);
  });
});
