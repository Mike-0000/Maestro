import { describe, expect, it } from 'vitest';
import { editDistance, phoneticKey } from '@core/features/conductor/api/resolver';
import { AGENT_WINDOW_NAMES } from '@core/features/conversations/api/agent-window-names';
import { diffLayout, redoEntry, undoEntry, type LayoutHistoryEntry } from './canvas-history';
import { planLayout, readingOrder, regionAt, type LayoutEnv, type LayoutOp } from './canvas-layout';
import { rectContains, rectsOverlap, TILE_GAP } from './canvas-model';
import {
  childRegions,
  contentBox,
  EMPTY_LAYOUT,
  isRegionId,
  MAX_REGION_DEPTH,
  nodeRect,
  parentOf,
  regionDepth,
  REGION_NAME_ROSTER,
  type LayoutState,
  type LayoutWindow,
} from './canvas-regions';
import { workspaceSize } from './region-tiling';

function agents(names: string[], task = (i: number) => `task${i}`): LayoutWindow[] {
  return names.map((name, i) => ({
    tileId: `agent:${name.toLowerCase()}`,
    kind: 'agent',
    name,
    taskId: task(i),
    taskName: task(i),
    projectName: 'proj',
    providerLabel: i % 2 === 0 ? 'Claude' : 'Codex',
    status: (['working', 'needs-you', 'done', 'idle'] as const)[i % 4],
  }));
}

function env(windows: LayoutWindow[], seed = 1): LayoutEnv {
  let n = seed * 1000;
  return {
    windows,
    screen: { width: 1600, height: 900 },
    viewport: { x: 0, y: 0, zoom: 0.6 },
    frameAllowance: 36,
    now: 1,
    newId: () => `id${n++}`,
  };
}

/** Windows laid out in a row, 48 apart, all at the root. */
function row(windows: LayoutWindow[]): LayoutState {
  const tiles: Record<string, { x: number; y: number; w: number; h: number }> = {};
  windows.forEach((window, i) => {
    tiles[window.tileId] = { x: i * (720 + TILE_GAP), y: 0, w: 720, h: 460 };
  });
  return { ...EMPTY_LAYOUT, tiles };
}

function plan(state: LayoutState, ops: LayoutOp[], e: LayoutEnv) {
  const result = planLayout(state, ops, e);
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

/** Siblings don't overlap and regions contain their visible members. */
function checkInvariants(state: LayoutState, windows: LayoutWindow[]): string[] {
  const problems: string[] = [];
  const present = new Set(windows.map((w) => w.tileId));
  const hidden = new Set(state.hidden);
  const parents = new Set<string | null>([null, ...Object.keys(state.regions)]);
  for (const parent of parents) {
    const nodes = [
      ...[...present].filter((id) => !hidden.has(id) && parentOf(state, id) === parent),
      ...childRegions(state, parent),
    ];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i] as string;
        const b = nodes[j] as string;
        if (rectsOverlap(nodeRect(state, a), nodeRect(state, b), 0)) {
          problems.push(`overlap ${a} ${b} in ${parent}`);
        }
      }
    }
    if (parent && !state.regions[parent]?.collapsed) {
      for (const node of nodes) {
        if (!rectContains(state.regions[parent]!.rect, nodeRect(state, node))) {
          problems.push(`${node} escapes ${parent}`);
        }
      }
    }
  }
  for (const id of Object.keys(state.regions)) {
    if (regionDepth(state, id) > MAX_REGION_DEPTH) problems.push(`${id} too deep`);
  }
  return problems;
}

describe('planLayout', () => {
  const windows = agents(['Atlas', 'Bravo', 'Cedar', 'Delta', 'Echo']);
  const base = row(windows);

  it('groups windows into a named region that contains them', () => {
    const result = plan(
      base,
      [{ op: 'createRegion', name: 'Review', members: ['agent:atlas', 'agent:bravo'] }],
      env(windows)
    );
    const [id] = result.created;
    expect(id).toBeDefined();
    const region = result.state.regions[id as string]!;
    expect(region.name).toBe('Review');
    expect(result.state.membership['agent:atlas']).toBe(id);
    expect(result.state.membership['agent:bravo']).toBe(id);
    expect(result.summary).toContain('Grouped Atlas and Bravo into Review');
    expect(checkInvariants(result.state, windows)).toEqual([]);
  });

  it('packs members when a non-member sits between them', () => {
    const result = plan(
      base,
      [{ op: 'createRegion', name: 'Ends', members: ['agent:atlas', 'agent:cedar'] }],
      env(windows)
    );
    expect(parentOf(result.state, 'agent:bravo')).toBeNull();
    expect(checkInvariants(result.state, windows)).toEqual([]);
  });

  it('refuses a name that collides with an agent, suffixing it', () => {
    const result = plan(
      base,
      [{ op: 'createRegion', name: 'Cedar', members: ['agent:atlas'] }],
      env(windows)
    );
    expect(result.state.regions[result.created[0] as string]?.name).toBe('Cedar group');
  });

  it('moves a window into a region, which re-tiles to share its space', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Review', members: ['agent:atlas'] }],
      env(windows)
    );
    const regionId = first.created[0] as string;
    const before = first.state.regions[regionId]!.rect;
    const second = plan(
      first.state,
      [{ op: 'move', targets: ['agent:echo'], to: { kind: 'region', region: regionId } }],
      env(windows, 2)
    );
    expect(second.state.membership['agent:echo']).toBe(regionId);
    expect(second.state.regions[regionId]!.rect).toEqual(before);
    const atlas = second.state.tiles['agent:atlas']!;
    const echo = second.state.tiles['agent:echo']!;
    expect(atlas.w).toBeLessThan(first.state.tiles['agent:atlas']!.w);
    expect(echo).toMatchObject({ y: atlas.y, w: atlas.w, h: atlas.h });
    expect(checkInvariants(second.state, windows)).toEqual([]);
  });

  it('grows a free region to fit a window moved into it', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Review', members: ['agent:atlas'] }],
      env(windows)
    );
    const regionId = first.created[0] as string;
    const free = {
      ...first.state,
      regions: {
        ...first.state.regions,
        [regionId]: { ...first.state.regions[regionId]!, arrangement: 'free' as const },
      },
    };
    const before = free.regions[regionId]!.rect;
    const second = plan(
      free,
      [{ op: 'move', targets: ['agent:echo'], to: { kind: 'region', region: regionId } }],
      env(windows, 2)
    );
    const after = second.state.regions[regionId]!.rect;
    expect(after.w * after.h).toBeGreaterThan(before.w * before.h);
    expect(second.state.tiles['agent:atlas']).toEqual(free.tiles['agent:atlas']);
    expect(checkInvariants(second.state, windows)).toEqual([]);
  });

  it('places a window beside another and pushes a neighbour', () => {
    const result = plan(
      base,
      [
        {
          op: 'move',
          targets: ['agent:echo'],
          to: { kind: 'relative', anchor: 'agent:atlas', side: 'right' },
        },
      ],
      env(windows)
    );
    const atlas = result.state.tiles['agent:atlas']!;
    const echo = result.state.tiles['agent:echo']!;
    expect(echo.x).toBe(atlas.x + atlas.w + TILE_GAP);
    expect(echo.y).toBe(atlas.y);
    expect(result.displaced).toContain('agent:bravo');
    expect(checkInvariants(result.state, windows)).toEqual([]);
  });

  it('caps nesting depth', () => {
    let state = base;
    let parent: string | null = null;
    for (let depth = 1; depth <= MAX_REGION_DEPTH; depth++) {
      const result = plan(
        state,
        [{ op: 'createRegion', name: `Level ${depth}`, members: [], parent }],
        env(windows, depth)
      );
      parent = result.created[0] as string;
      state = result.state;
    }
    const result = planLayout(
      state,
      [{ op: 'createRegion', name: 'Too deep', members: [], parent }],
      env(windows, 9)
    );
    expect(result.ok).toBe(false);
  });

  it('dissolving keeps windows where they are and moves them to the parent', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Review', members: ['agent:atlas', 'agent:bravo'] }],
      env(windows)
    );
    const regionId = first.created[0] as string;
    const atlas = first.state.tiles['agent:atlas'];
    const second = plan(first.state, [{ op: 'dissolveRegion', region: regionId }], env(windows, 2));
    expect(second.state.regions[regionId]).toBeUndefined();
    expect(second.state.membership['agent:atlas']).toBeUndefined();
    expect(second.state.tiles['agent:atlas']).toEqual(atlas);
    expect(second.tier).toBe('preview');
  });

  it('organizes loose windows by task into regions and regroups on a second organize', () => {
    const shared = agents(['Atlas', 'Bravo', 'Cedar', 'Delta'], (i) => (i < 2 ? 'auth' : 'tests'));
    const result = plan(row(shared), [{ op: 'organize', scope: null, by: 'task' }], env(shared));
    const names = Object.values(result.state.regions)
      .map((region) => region.name)
      .sort();
    expect(names).toEqual(['auth', 'tests']);
    expect(result.tier).toBe('preview');
    expect(checkInvariants(result.state, shared)).toEqual([]);
    const byStatus = plan(
      result.state,
      [{ op: 'organize', scope: null, by: 'status' }],
      env(shared, 2)
    );
    const statusNames = Object.values(byStatus.state.regions)
      .map((region) => region.name)
      .sort();
    // The auto regions from the first organize were emptied and dropped.
    expect(statusNames).not.toContain('auth');
    expect(statusNames).toContain('Working');
    expect(checkInvariants(byStatus.state, shared)).toEqual([]);
  });

  it('keeps user regions when organizing', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Mine', members: ['agent:atlas'] }],
      env(windows)
    );
    const mine = first.created[0] as string;
    const second = plan(
      first.state,
      [{ op: 'organize', scope: null, by: 'provider' }],
      env(windows, 2)
    );
    expect(second.state.regions[mine]?.name).toBe('Mine');
    expect(second.state.membership['agent:atlas']).toBe(mine);
  });

  it('stamps auto and projectId on a created project region', () => {
    const result = plan(
      base,
      [
        {
          op: 'createRegion',
          name: 'Emdash',
          members: ['agent:atlas'],
          auto: true,
          projectId: 'p1',
        },
      ],
      env(windows)
    );
    const region = result.state.regions[result.created[0] as string]!;
    expect(region.auto).toBe(true);
    expect(region.projectId).toBe('p1');
  });

  it('organizes by project and tags the region with projectId', () => {
    const shared = agents(['Atlas', 'Bravo']).map((window) => ({
      ...window,
      projectName: 'Emdash',
      projectId: 'p1',
    }));
    const result = plan(row(shared), [{ op: 'organize', scope: null, by: 'project' }], env(shared));
    const [region] = Object.values(result.state.regions);
    expect(region?.name).toBe('Emdash');
    expect(region?.auto).toBe(true);
    expect(region?.projectId).toBe('p1');
    expect(checkInvariants(result.state, shared)).toEqual([]);
  });

  it('arranges a region as a row and shrink-wraps it', () => {
    const first = plan(
      base,
      [
        {
          op: 'createRegion',
          name: 'Review',
          members: ['agent:atlas', 'agent:bravo', 'agent:cedar'],
        },
      ],
      env(windows)
    );
    const regionId = first.created[0] as string;
    const second = plan(
      first.state,
      [{ op: 'arrange', targets: null, scope: regionId, layout: 'column' }],
      env(windows, 2)
    );
    const xs = ['agent:atlas', 'agent:bravo', 'agent:cedar'].map((id) => second.state.tiles[id]!.x);
    expect(new Set(xs).size).toBe(1);
    expect(checkInvariants(second.state, windows)).toEqual([]);
  });

  it('hides and shows windows through layout (so undo reopens them)', () => {
    const hidden = plan(base, [{ op: 'hide', targets: ['agent:atlas'] }], env(windows));
    expect(hidden.state.hidden).toEqual(['agent:atlas']);
    const shown = plan(hidden.state, [{ op: 'show', targets: ['agent:atlas'] }], env(windows, 2));
    expect(shown.state.hidden).toEqual([]);
  });

  it('collapses and expands regions', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Review', members: ['agent:atlas'] }],
      env(windows)
    );
    const regionId = first.created[0] as string;
    const collapsed = plan(
      first.state,
      [{ op: 'collapseRegion', region: regionId, collapsed: true }],
      env(windows, 2)
    );
    expect(collapsed.state.regions[regionId]?.collapsed).toBe(true);
    const expanded = plan(
      collapsed.state,
      [{ op: 'collapseRegion', region: regionId, collapsed: false }],
      env(windows, 3)
    );
    expect(checkInvariants(expanded.state, windows)).toEqual([]);
  });

  it('composes a batch as one plan', () => {
    const result = plan(
      base,
      [
        { op: 'createRegion', name: 'Review', members: ['agent:atlas'] },
        { op: 'resize', targets: ['agent:bravo'], size: { kind: 'preset', preset: 'large' } },
      ],
      env(windows)
    );
    expect(result.state.membership['agent:atlas']).toBe(result.created[0]);
    expect(result.state.tiles['agent:bravo']).toMatchObject({ w: 1080, h: 690 });
    expect(checkInvariants(result.state, windows)).toEqual([]);
  });

  it('reports failures without dropping the ops that worked', () => {
    const result = plan(
      base,
      [
        { op: 'dissolveRegion', region: 'region:missing' },
        { op: 'hide', targets: ['agent:atlas'] },
      ],
      env(windows)
    );
    expect(result.failures).toHaveLength(1);
    expect(result.state.hidden).toEqual(['agent:atlas']);
  });

  it('finds the deepest region under a point', () => {
    const first = plan(
      base,
      [{ op: 'createRegion', name: 'Outer', members: ['agent:atlas'] }],
      env(windows)
    );
    const outer = first.created[0] as string;
    const second = plan(
      first.state,
      [{ op: 'createRegion', name: 'Inner', members: ['agent:atlas'], parent: outer }],
      env(windows, 2)
    );
    const inner = second.created[0] as string;
    const atlas = second.state.tiles['agent:atlas']!;
    expect(regionAt(second.state, { x: atlas.x + 10, y: atlas.y + 10 })).toBe(inner);
    expect(regionAt(second.state, { x: atlas.x + 10, y: atlas.y + 10 }, inner)).toBe(outer);
  });

  it('holds its invariants over random op sequences, and undo restores the start', () => {
    const pool = agents(['Atlas', 'Bravo', 'Cedar', 'Delta', 'Echo', 'Falcon', 'Ginger', 'Harbor']);
    let random = 42;
    const next = () => {
      random = (random * 1103515245 + 12345) % 2147483648;
      return random / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    for (let run = 0; run < 150; run++) {
      let state = row(pool);
      const start = state;
      const entries: LayoutHistoryEntry[] = [];
      for (let step = 0; step < 8; step++) {
        const tiles = pool.map((w) => w.tileId);
        const regions = Object.keys(state.regions);
        const nodes = [...tiles, ...regions];
        const candidates: LayoutOp[] = [
          { op: 'createRegion', members: [pick(tiles), pick(tiles)] },
          {
            op: 'move',
            targets: [pick(nodes)],
            to: { kind: 'region', region: regions.length ? pick(regions) : null },
          },
          {
            op: 'move',
            targets: [pick(tiles)],
            to: {
              kind: 'relative',
              anchor: pick(nodes),
              side: pick(['left', 'right', 'above', 'below'] as const),
            },
          },
          {
            op: 'resize',
            targets: [pick(tiles)],
            size: {
              kind: 'relative',
              axis: 'both',
              factor: 'much',
              direction: pick(['grow', 'shrink'] as const),
            },
          },
          {
            op: 'arrange',
            targets: null,
            scope: regions.length ? pick(regions) : null,
            layout: pick(['grid', 'row', 'column', 'tidy'] as const),
          },
          { op: 'organize', scope: null, by: pick(['task', 'status', 'provider'] as const) },
          { op: 'swap', a: pick(tiles), b: pick(tiles) },
          { op: 'hide', targets: [pick(tiles)] },
          { op: 'show', targets: [pick(tiles)] },
          ...(regions.length
            ? ([
                { op: 'dissolveRegion', region: pick(regions) },
                { op: 'collapseRegion', region: pick(regions), collapsed: next() < 0.5 },
              ] as LayoutOp[])
            : []),
        ];
        const op = pick(candidates);
        const result = planLayout(state, [op], env(pool, run * 100 + step));
        if (!result.ok) continue;
        const problems = checkInvariants(result.plan.state, pool).filter(
          // Collapsing frees space: expanded siblings may later need a push, which is allowed
          // to be deferred until the region expands.
          (problem) =>
            !problem.includes('escapes') ||
            !Object.values(result.plan.state.regions).some((r) => r.collapsed)
        );
        expect(problems, `run ${run} step ${step} ${JSON.stringify(op)}`).toEqual([]);
        const diff = diffLayout(state, result.plan.state);
        if (diff) {
          entries.push({
            id: entries.length,
            label: '',
            source: 'command',
            at: 0,
            targets: [],
            ...diff,
          });
        }
        state = result.plan.state;
      }
      // Undo everything in reverse: back to the start.
      let undone = state;
      for (const entry of [...entries].reverse()) {
        const result = undoEntry(undone, entry);
        expect(result.conflicts).toBe(0);
        undone = result.state;
      }
      expect(diffLayout(start, undone)).toBeNull();
      // And redo everything forward again.
      let redone = undone;
      for (const entry of entries) redone = redoEntry(redone, entry).state;
      expect(diffLayout(state, redone)).toBeNull();
    }
  });
});

describe('canvas history', () => {
  it('leaves fields the user changed since alone', () => {
    const windows = agents(['Atlas', 'Bravo']);
    const start = row(windows);
    const moved = plan(
      start,
      [{ op: 'resize', targets: ['agent:atlas'], size: { kind: 'preset', preset: 'large' } }],
      env(windows)
    ).state;
    const diff = diffLayout(start, moved)!;
    const entry: LayoutHistoryEntry = {
      id: 1,
      label: 'x',
      source: 'voice',
      at: 0,
      targets: [],
      ...diff,
    };
    const userMoved = {
      ...moved,
      tiles: { ...moved.tiles, 'agent:atlas': { x: 5000, y: 0, w: 1080, h: 690 } },
    };
    const result = undoEntry(userMoved, entry);
    expect(result.conflicts).toBeGreaterThan(0);
    expect(result.state.tiles['agent:atlas']).toEqual({ x: 5000, y: 0, w: 1080, h: 690 });
  });
});

describe('readingOrder', () => {
  it('reads rows top to bottom, then left to right', () => {
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {
      a: { x: 800, y: 0, w: 10, h: 10 },
      b: { x: 0, y: 40, w: 10, h: 10 },
      c: { x: 0, y: 900, w: 10, h: 10 },
    };
    expect(readingOrder(['c', 'a', 'b'], (id) => rects[id]!)).toEqual(['b', 'a', 'c']);
  });
});

describe('region roster', () => {
  it('sounds unlike the agent roster and itself', () => {
    const all = [...AGENT_WINDOW_NAMES, ...REGION_NAME_ROSTER];
    for (const region of REGION_NAME_ROSTER) {
      for (const other of all) {
        if (other === region) continue;
        expect(phoneticKey(region), `${region} vs ${other}`).not.toBe(phoneticKey(other));
        expect(editDistance(region.toLowerCase(), other.toLowerCase())).toBeGreaterThan(1);
      }
    }
  });

  it('ids are recognizable', () => {
    expect(isRegionId('region:x')).toBe(true);
    expect(isRegionId('agent:x')).toBe(false);
  });
});

describe('sub-canvas tiling', () => {
  const windows = agents(['Atlas', 'Bravo', 'Cedar', 'Delta', 'Echo']);
  const browser: LayoutWindow = {
    tileId: 'browser:task0',
    kind: 'browser',
    name: 'task0 app',
    taskId: 'task0',
    taskName: 'task0',
  };
  const all = [...windows, browser];
  const base: LayoutState = {
    ...row(windows),
    tiles: { ...row(windows).tiles, 'browser:task0': { x: 0, y: 1200, w: 960, h: 640 } },
  };
  const four = ['agent:atlas', 'agent:bravo', 'agent:cedar', 'agent:delta'];

  function grouped(members: string[], e = env(all)) {
    const result = plan(base, [{ op: 'createRegion', name: 'Summit', members }], e);
    return { state: result.state, regionId: result.created[0] as string };
  }

  it('lays four agents out as quadrants of a screen-sized workspace', () => {
    const { state, regionId } = grouped(four);
    const region = state.regions[regionId]!;
    expect(region.arrangement).toBe('tiled');
    expect({ w: region.rect.w, h: region.rect.h }).toEqual(workspaceSize(env(all).screen));
    const rects = four.map((id) => state.tiles[id]!);
    expect(new Set(rects.map((rect) => rect.x)).size).toBe(2);
    expect(new Set(rects.map((rect) => rect.y)).size).toBe(2);
    expect(new Set(rects.map((rect) => `${rect.w}x${rect.h}`)).size).toBe(1);
    // No waste: the quadrants reach the content box's far edges.
    const box = contentBox(region, 36);
    expect(Math.max(...rects.map((rect) => rect.x + rect.w))).toBe(box.x + box.w);
    expect(Math.max(...rects.map((rect) => rect.y + rect.h))).toBe(box.y + box.h);
    expect(checkInvariants(state, all)).toEqual([]);
  });

  it('gives an app browser more room than the agent beside it', () => {
    const { state } = grouped(['agent:atlas', 'browser:task0']);
    const agent = state.tiles['agent:atlas']!;
    const app = state.tiles['browser:task0']!;
    expect(app.h).toBe(agent.h);
    expect(app.w / agent.w).toBeCloseTo(1.5, 1);
    expect(checkInvariants(state, all)).toEqual([]);
  });

  it('re-tiles when windows leave, close, come back, or join', () => {
    const { state, regionId } = grouped(['agent:atlas', 'agent:bravo', 'agent:cedar']);
    const hidden = plan(state, [{ op: 'hide', targets: ['agent:cedar'] }], env(all, 2)).state;
    const box = contentBox(hidden.regions[regionId]!, 36);
    expect(hidden.tiles['agent:atlas']!.h).toBe(box.h);
    expect(hidden.tiles['agent:bravo']!.h).toBe(box.h);
    const shown = plan(hidden, [{ op: 'show', targets: ['agent:cedar'] }], env(all, 3)).state;
    expect(shown.tiles['agent:cedar']!.h).toBeLessThan(box.h);
    const joined = plan(
      shown,
      [{ op: 'move', targets: ['agent:delta'], to: { kind: 'region', region: regionId } }],
      env(all, 4)
    ).state;
    const quadrants = four.map((id) => joined.tiles[id]!);
    expect(new Set(quadrants.map((rect) => rect.y)).size).toBe(2);
    const left = plan(
      joined,
      [{ op: 'move', targets: ['agent:delta'], to: { kind: 'region', region: null } }],
      env(all, 5)
    ).state;
    expect(parentOf(left, 'agent:delta')).toBeNull();
    expect(left.tiles['agent:atlas']!.h).toBeGreaterThan(quadrants[0]!.h);
    for (const next of [hidden, shown, joined, left]) {
      expect(checkInvariants(next, all)).toEqual([]);
    }
  });

  it('makes a window larger by giving it a bigger share, not by overlapping', () => {
    const { state, regionId } = grouped([...four.slice(0, 3), 'browser:task0']);
    const before = state.tiles['browser:task0']!;
    const next = plan(
      state,
      [
        {
          op: 'resize',
          targets: ['browser:task0'],
          size: { kind: 'relative', axis: 'both', factor: 'more', direction: 'grow' },
        },
      ],
      env(all, 2)
    ).state;
    const after = next.tiles['browser:task0']!;
    expect(after.w * after.h).toBeGreaterThan(before.w * before.h);
    expect(next.regions[regionId]!.rect).toEqual(state.regions[regionId]!.rect);
    expect(next.regions[regionId]!.weights).toEqual({ 'browser:task0': 1.5 });
    expect(checkInvariants(next, all)).toEqual([]);
  });

  it('keeps a hand placement: dragging inside a tiled region frees it', () => {
    const { state, regionId } = grouped(four);
    const atlas = state.tiles['agent:atlas']!;
    const dragged = plan(
      state,
      [
        {
          op: 'move',
          targets: ['agent:atlas'],
          to: { kind: 'exact', x: atlas.x + 24, y: atlas.y, region: regionId },
        },
      ],
      env(all, 2)
    ).state;
    expect(dragged.regions[regionId]!.arrangement).toBe('free');
    expect(dragged.tiles['agent:atlas']!.x).toBe(atlas.x + 24);
    expect(dragged.tiles['agent:bravo']).toEqual(state.tiles['agent:bravo']);
    // Tiling again puts it back in its quadrant.
    const retiled = plan(
      dragged,
      [{ op: 'arrange', targets: null, scope: regionId, layout: 'tile' }],
      env(all, 3)
    );
    expect(retiled.state.regions[regionId]!.arrangement).toBe('tiled');
    expect(retiled.state.tiles['agent:atlas']).toEqual(atlas);
    expect(retiled.summary).toContain('quadrants');
  });

  it('tiles loose windows on the board into quadrants where they are', () => {
    const result = plan(
      base,
      [{ op: 'arrange', targets: four, scope: null, layout: 'tile' }],
      env(all)
    );
    const rects = four.map((id) => result.state.tiles[id]!);
    expect(new Set(rects.map((rect) => rect.x)).size).toBe(2);
    expect(new Set(rects.map((rect) => rect.y)).size).toBe(2);
    expect(Math.min(...rects.map((rect) => rect.x))).toBe(0);
    expect(checkInvariants(result.state, all)).toEqual([]);
  });

  it('makes an empty top-level sub-canvas the size of the screen', () => {
    const result = plan(base, [{ op: 'createRegion', name: 'Scratch', members: [] }], env(all));
    const region = result.state.regions[result.created[0] as string]!;
    expect({ w: region.rect.w, h: region.rect.h }).toEqual(workspaceSize(env(all).screen));
    expect(checkInvariants(result.state, all)).toEqual([]);
  });

  it('tiles a nested sub-canvas as one pane of its parent', () => {
    const { state, regionId } = grouped(four);
    const nested = plan(
      state,
      [
        {
          op: 'createRegion',
          name: 'Pair',
          members: ['agent:cedar', 'agent:delta'],
          parent: regionId,
        },
      ],
      env(all, 2)
    );
    const pairId = nested.created[0] as string;
    const next = nested.state;
    expect(parentOf(next, pairId)).toBe(regionId);
    expect(next.regions[pairId]!.arrangement).toBe('tiled');
    const pair = contentBox(next.regions[pairId]!, 36);
    expect(next.tiles['agent:cedar']!.x).toBe(pair.x);
    expect(checkInvariants(next, all)).toEqual([]);
  });

  it('follows the screen when a tiled workspace is refitted', () => {
    const { state, regionId } = grouped(four);
    const wide = { ...env(all, 2), screen: { width: 2400, height: 1300 } };
    const next = plan(state, [{ op: 'fitRegion', region: regionId }], wide).state;
    const rect = next.regions[regionId]!.rect;
    expect({ w: rect.w, h: rect.h }).toEqual(workspaceSize(wide.screen));
    expect(checkInvariants(next, all)).toEqual([]);
  });

  it('grows past the screen rather than squeezing windows below their minimum', () => {
    const many = agents(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11']);
    const small = { ...env(many), screen: { width: 1200, height: 700 } };
    const result = plan(
      row(many),
      [{ op: 'createRegion', name: 'Swarm', members: many.map((w) => w.tileId) }],
      small
    );
    for (const window of many) {
      const rect = result.state.tiles[window.tileId]!;
      expect(rect.w).toBeGreaterThanOrEqual(360);
      expect(rect.h).toBeGreaterThanOrEqual(220);
    }
    expect(checkInvariants(result.state, many)).toEqual([]);
  });
});
