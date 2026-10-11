import { describe, expect, it } from 'vitest';
import {
  planLayout,
  readingOrder,
  settleDesks,
  type LayoutEnv,
  type LayoutOp,
} from './canvas-layout';
import type { TileRect } from './canvas-model';
import {
  EMPTY_LAYOUT,
  isRegionId,
  parentOf,
  type LayoutState,
  type LayoutWindow,
  type RegionState,
} from './canvas-regions';
import {
  DESK_GAP,
  DESK_INSETS,
  DESK_PAGE_CAP,
  deskMinSize,
  deskPageBox,
  deskPageCount,
  deskPageOf,
  deskPageSize,
  deskPitch,
  deskRectSize,
  deskViolations,
  layoutTreeWithin,
  paginateDesk,
  shareWithMinimums,
  treeMinSize,
  type DeskScreen,
} from './desk-layout';
import { frameViewport, tilingTree, type TilingItem } from './region-tiling';

const SCREEN: DeskScreen = { width: 1600, height: 900 };

function items(ids: readonly string[], weights: Record<string, number> = {}): TilingItem[] {
  return ids.map((id) => ({ id, weight: weights[id] ?? 1, min: deskMinSize(id) }));
}

const agents = (count: number) => Array.from({ length: count }, (_, i) => `agent:a${i}`);

describe('desk pages', () => {
  it('a page is the screen less the desk insets, and pages are one screen apart', () => {
    expect(deskPageSize(SCREEN)).toEqual({
      w: 1600 - DESK_INSETS.left - DESK_INSETS.right,
      h: 900 - DESK_INSETS.top - DESK_INSETS.bottom,
    });
    expect(deskPitch(SCREEN)).toBe(900);
  });

  it('frames every page at zoom 1, exactly inside the insets', () => {
    const desk = { x: 480, y: -960, ...deskRectSize(SCREEN, 3) };
    for (const page of [0, 1, 2]) {
      const box = deskPageBox(desk, SCREEN, page);
      const camera = frameViewport(box, SCREEN, DESK_INSETS);
      expect(camera.zoom).toBe(1);
      // The page's top-left lands at the inset corner of the screen.
      expect(box.x * camera.zoom + camera.x).toBe(DESK_INSETS.left);
      expect(box.y * camera.zoom + camera.y).toBe(DESK_INSETS.top);
    }
  });

  it('counts pages from the desk rect and finds the page a rect is on', () => {
    for (const pages of [1, 2, 5]) {
      const desk = { x: 0, y: 0, ...deskRectSize(SCREEN, pages) };
      expect(deskPageCount(desk, SCREEN)).toBe(pages);
      const last = deskPageBox(desk, SCREEN, pages - 1);
      expect(deskPageOf(desk, SCREEN, { ...last, w: 400, h: 300 })).toBe(pages - 1);
    }
  });

  it('keeps neighbouring pages off screen', () => {
    const desk = { x: 0, y: 0, ...deskRectSize(SCREEN, 2) };
    const first = deskPageBox(desk, SCREEN, 0);
    const second = deskPageBox(desk, SCREEN, 1);
    // What the camera shows of the board while page 0 is framed ends above page 1.
    const visibleBottom = first.y + first.h + DESK_INSETS.bottom;
    expect(second.y).toBeGreaterThanOrEqual(visibleBottom);
  });
});

describe('sharing with minimums', () => {
  it('shares by ratio when everyone has room', () => {
    expect(shareWithMinimums(900, [1, 2], [100, 100])).toEqual([300, 600]);
  });

  it('holds a pane at its minimum and shares the rest', () => {
    const sizes = shareWithMinimums(1000, [1, 1, 8], [300, 300, 100]);
    expect(sizes).toEqual([300, 300, 400]);
  });

  it('falls back to the ratios when the minimums do not fit', () => {
    expect(shareWithMinimums(300, [1, 1], [200, 200])).toEqual([150, 150]);
  });

  it('never lets a heavy pane starve its neighbours', () => {
    const list = items(agents(4), { 'agent:a0': 6 });
    const page = deskPageSize(SCREEN);
    const mins = new Map(list.map((item) => [item.id, item.min]));
    const tree = tilingTree(list, page.w / page.h);
    expect(treeMinSize(tree, mins, DESK_GAP).w).toBeLessThanOrEqual(page.w);
    const panes = layoutTreeWithin(tree, { x: 0, y: 0, ...page }, DESK_GAP, mins);
    for (const pane of panes) {
      const min = deskMinSize(pane.tileId);
      expect(pane.rect.w).toBeGreaterThanOrEqual(min.w - 0.5);
      expect(pane.rect.h).toBeGreaterThanOrEqual(min.h - 0.5);
    }
    const heavy = panes.find((pane) => pane.tileId === 'agent:a0');
    const light = panes.find((pane) => pane.tileId === 'agent:a3');
    expect((heavy?.rect.w ?? 0) * (heavy?.rect.h ?? 0)).toBeGreaterThan(
      (light?.rect.w ?? 0) * (light?.rect.h ?? 0)
    );
  });
});

describe('paging a desk', () => {
  const page = () => deskPageSize(SCREEN);

  it('keeps everything on one page while it fits comfortably', () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      expect(paginateDesk(items(agents(count)), page, DESK_GAP).map((p) => p.length)).toEqual([
        count,
      ]);
    }
  });

  it('starts a new page rather than squeezing panes under their comfortable size', () => {
    // Nine agents would be three rows of 273 px on this screen: under the 280 px minimum.
    expect(paginateDesk(items(agents(7)), page, DESK_GAP).map((p) => p.length)).toEqual([6, 1]);
    expect(paginateDesk(items(agents(13)), page, DESK_GAP).map((p) => p.length)).toEqual([6, 6, 1]);
  });

  it('puts more on a page of a bigger screen, up to the cap', () => {
    const big = () => deskPageSize({ width: 3840, height: 2160 });
    const pages = paginateDesk(items(agents(30)), big, DESK_GAP).map((p) => p.length);
    expect(pages[0]).toBe(DESK_PAGE_CAP);
    expect(pages.reduce((sum, n) => sum + n, 0)).toBe(30);
  });

  it('gives a window too big for the screen a page of its own', () => {
    const tiny = () => deskPageSize({ width: 500, height: 400 });
    expect(paginateDesk(items(agents(3)), tiny, DESK_GAP).map((p) => p.length)).toEqual([1, 1, 1]);
  });

  it('does not reshuffle earlier pages when a window is added', () => {
    const before = paginateDesk(items(agents(7)), page, DESK_GAP);
    const after = paginateDesk(items(agents(8)), page, DESK_GAP);
    expect(after[0]?.map((item) => item.id)).toEqual(before[0]?.map((item) => item.id));
  });
});

// ── The planner keeps the rules ─────────────────────────────────────────────

function region(name: string, patch: Partial<RegionState> = {}): RegionState {
  return {
    name,
    parentId: null,
    rect: { x: 0, y: 0, w: 900, h: 500 },
    collapsed: false,
    createdAt: 1,
    ...patch,
  };
}

function windowOf(tileId: string): LayoutWindow {
  const kind = tileId.startsWith('browser:')
    ? 'browser'
    : tileId.startsWith('note:')
      ? 'note'
      : tileId.startsWith('doc:')
        ? 'doc'
        : 'agent';
  return { tileId, kind, name: tileId.split(':')[1] ?? tileId };
}

function env(ids: readonly string[], patch: Partial<LayoutEnv> = {}): LayoutEnv {
  let n = 0;
  return {
    windows: ids.map(windowOf),
    screen: SCREEN,
    viewport: { x: 0, y: 0, zoom: 1 },
    frameAllowance: 0,
    now: 10,
    newId: () => `region:new${n++}`,
    desks: true,
    ...patch,
  };
}

function check(state: LayoutState, e: LayoutEnv) {
  const hidden = new Set(state.hidden);
  return {
    screen: e.screen,
    frameAllowance: e.frameAllowance,
    present: new Set(e.windows.map((w) => w.tileId).filter((id) => !hidden.has(id))),
  };
}

/** Every desk's violations, as `desk: violation` lines (empty when all hold the rules). */
function violations(state: LayoutState, e: LayoutEnv): string[] {
  return Object.keys(state.regions)
    .filter((id) => parentOf(state, id) === null)
    .flatMap((id) => deskViolations(state, id, check(state, e)).map((v) => `${id}: ${v}`));
}

/** A desk holding `ids` scattered as they would be on a free region of the classic canvas. */
function looseDesk(ids: readonly string[], patch: Partial<RegionState> = {}): LayoutState {
  const tiles: Record<string, TileRect> = {};
  ids.forEach((id, index) => {
    tiles[id] = { x: 40 + index * 310, y: 80 + (index % 2) * 37, w: 300, h: 200 };
  });
  return {
    ...EMPTY_LAYOUT,
    tiles,
    regions: { 'region:main': region('Main', patch) },
    membership: Object.fromEntries(ids.map((id) => [id, 'region:main'])),
  };
}

/** What differs between two layouts, one line per window or region. */
function changes(a: LayoutState, b: LayoutState): string[] {
  const line = (id: string, from: unknown, to: unknown) =>
    JSON.stringify(from) === JSON.stringify(to)
      ? []
      : [`${id}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`];
  return [
    ...Object.keys({ ...a.tiles, ...b.tiles }).flatMap((id) => line(id, a.tiles[id], b.tiles[id])),
    ...Object.keys({ ...a.regions, ...b.regions }).flatMap((id) =>
      line(id, a.regions[id], b.regions[id])
    ),
  ];
}

function run(state: LayoutState, ops: LayoutOp[], e: LayoutEnv): LayoutState {
  const result = planLayout(state, ops, e);
  if (!result.ok) throw new Error(result.reason);
  return result.plan.state;
}

function tileOf(state: LayoutState, id: string): TileRect {
  return state.tiles[id] as TileRect;
}

describe('a desk always fills the screen', () => {
  it('validates nothing it should not: a free region scattered on a board is in violation', () => {
    const ids = agents(3);
    const state = looseDesk(ids);
    expect(deskViolations(state, 'region:main', check(state, env(ids)))).toEqual(
      expect.arrayContaining(['not-tiled', 'wrong-size', 'unfilled'])
    );
  });

  it('tiles a free, hand-sized region when it becomes a desk', () => {
    const ids = agents(3);
    const e = env(ids);
    const state = settleDesks(looseDesk(ids, { arrangement: 'free', screenSized: false }), e);
    expect(violations(state, e)).toEqual([]);
    expect(state.regions['region:main']).toMatchObject({ arrangement: 'tiled' });
    expect(state.regions['region:main']?.screenSized).toBeUndefined();
  });

  it('covers the page edge to edge with one window, and with six', () => {
    for (const count of [1, 6]) {
      const ids = agents(count);
      const e = env(ids);
      const state = settleDesks(looseDesk(ids), e, ['region:main']);
      const page = deskPageBox(state.regions['region:main']?.rect as TileRect, SCREEN, 0);
      const rects = ids.map((id) => tileOf(state, id));
      expect(Math.min(...rects.map((r) => r.x))).toBe(page.x);
      expect(Math.min(...rects.map((r) => r.y))).toBe(page.y);
      expect(Math.max(...rects.map((r) => r.x + r.w))).toBe(page.x + page.w);
      expect(Math.max(...rects.map((r) => r.y + r.h))).toBe(page.y + page.h);
      expect(violations(state, e)).toEqual([]);
    }
  });

  it('uses far more of the screen than a classic sub-canvas does', () => {
    const ids = agents(4);
    const e = env(ids);
    const area = (state: LayoutState) =>
      ids.reduce((sum, id) => sum + tileOf(state, id).w * tileOf(state, id).h, 0);
    const desk = settleDesks(looseDesk(ids), e, ['region:main']);
    const classic = run(
      looseDesk(ids, { arrangement: 'tiled' }),
      [{ op: 'fitRegion', region: 'region:main' }],
      { ...e, desks: false }
    );
    const screen = SCREEN.width * SCREEN.height;
    expect(area(classic) / screen).toBeLessThan(0.78);
    expect(area(desk) / screen).toBeGreaterThan(0.9);
  });

  it('pages a desk too full for one screen, each page full', () => {
    const ids = agents(8);
    const e = env(ids);
    const state = settleDesks(looseDesk(ids), e, ['region:main']);
    const desk = state.regions['region:main']?.rect as TileRect;
    expect(deskPageCount(desk, SCREEN)).toBe(2);
    const pages = ids.map((id) => deskPageOf(desk, SCREEN, tileOf(state, id)));
    expect(pages.filter((page) => page === 0)).toHaveLength(6);
    expect(pages.filter((page) => page === 1)).toHaveLength(2);
    expect(violations(state, e)).toEqual([]);
  });

  it('pulls a window up from the next page when one closes', () => {
    const ids = agents(7);
    const e = env(ids);
    const two = settleDesks(looseDesk(ids), e, ['region:main']);
    expect(deskPageCount(two.regions['region:main']?.rect as TileRect, SCREEN)).toBe(2);
    const one = run(two, [{ op: 'hide', targets: ['agent:a0'] }], e);
    expect(deskPageCount(one.regions['region:main']?.rect as TileRect, SCREEN)).toBe(1);
    expect(violations(one, e)).toEqual([]);
  });

  it('is laid out the same when laid out again (a repair cannot loop)', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 9, 14]) {
      const ids = [...agents(count), 'browser:b0', 'note:n0'];
      const e = env(ids);
      const once = settleDesks(looseDesk(ids), e, ['region:main']);
      const twice = settleDesks(once, e, ['region:main']);
      expect(twice).toEqual(once);
    }
  });

  it('follows the screen', () => {
    const ids = agents(4);
    const small = env(ids, { screen: { width: 1100, height: 700 } });
    const state = settleDesks(settleDesks(looseDesk(ids), env(ids)), small, ['region:main']);
    expect(violations(state, small)).toEqual([]);
    expect(violations(state, env(ids))).toContain('region:main: wrong-size');
  });

  it('leaves room for task frames when they show', () => {
    const ids = agents(4);
    const e = env(ids, { frameAllowance: 36 });
    const state = settleDesks(looseDesk(ids), e, ['region:main']);
    expect(violations(state, e)).toEqual([]);
    const page = deskPageBox(state.regions['region:main']?.rect as TileRect, SCREEN, 0);
    // A frame's header fits above the top row, on the page.
    expect(Math.min(...ids.map((id) => tileOf(state, id).y))).toBe(page.y + 36);
  });

  it('is still a valid region on the classic canvas: its members sit below its header', () => {
    const ids = agents(3);
    const state = settleDesks(looseDesk(ids), env(ids), ['region:main']);
    const desk = state.regions['region:main']?.rect as TileRect;
    for (const id of ids) {
      const rect = tileOf(state, id);
      expect(rect.y).toBeGreaterThanOrEqual(desk.y + 40);
      expect(rect.x).toBeGreaterThan(desk.x);
      expect(rect.x + rect.w).toBeLessThan(desk.x + desk.w);
      expect(rect.y + rect.h).toBeLessThan(desk.y + desk.h);
    }
  });
});

describe('ops on a desk keep it full', () => {
  const ids = agents(4);
  const e = env(ids);
  const start = settleDesks(looseDesk(ids), e, ['region:main']);
  const order = (state: LayoutState) => readingOrder(ids, (id) => tileOf(state, id));

  it('a drop onto another window trades places with it', () => {
    const target = tileOf(start, 'agent:a3');
    const state = run(
      start,
      [
        {
          op: 'move',
          targets: ['agent:a0'],
          to: { kind: 'exact', x: target.x + 20, y: target.y + 20, region: 'region:main' },
        },
      ],
      e
    );
    expect(order(state)).toEqual(['agent:a3', 'agent:a1', 'agent:a2', 'agent:a0']);
    expect(violations(state, e)).toEqual([]);
    expect(state.regions['region:main']?.arrangement).toBe('tiled');
  });

  it('a nudge trades places with the neighbour on that side', () => {
    const state = run(
      start,
      [
        {
          op: 'move',
          targets: ['agent:a0'],
          to: { kind: 'nudge', direction: 'right', amount: 'bit' },
        },
      ],
      e
    );
    expect(order(state)).toEqual(['agent:a1', 'agent:a0', 'agent:a2', 'agent:a3']);
    expect(violations(state, e)).toEqual([]);
  });

  it('a nudge into the edge of the desk changes nothing', () => {
    const result = planLayout(
      start,
      [
        {
          op: 'move',
          targets: ['agent:a0'],
          to: { kind: 'nudge', direction: 'left', amount: 'far' },
        },
      ],
      e
    );
    expect(result.ok && result.plan.state.tiles).toEqual(start.tiles);
  });

  it('a hand resize changes the share, not the fill', () => {
    const rect = tileOf(start, 'agent:a0');
    const state = run(
      start,
      [
        {
          op: 'resize',
          targets: ['agent:a0'],
          size: { kind: 'exact', rect: { ...rect, w: rect.w * 1.4, h: rect.h * 1.4 } },
        },
      ],
      e
    );
    const after = tileOf(state, 'agent:a0');
    expect(after.w * after.h).toBeGreaterThan(rect.w * rect.h);
    expect(state.regions['region:main']?.weights?.['agent:a0']).toBeGreaterThan(1);
    expect(violations(state, e)).toEqual([]);
  });

  it('"much bigger" grows a window without pushing the others off the page or under size', () => {
    let state = start;
    for (let i = 0; i < 4; i++) {
      state = run(
        state,
        [
          {
            op: 'resize',
            targets: ['agent:a0'],
            size: { kind: 'relative', axis: 'both', factor: 'much', direction: 'grow' },
          },
        ],
        e
      );
    }
    expect(deskPageCount(state.regions['region:main']?.rect as TileRect, SCREEN)).toBe(1);
    expect(violations(state, e)).toEqual([]);
  });

  it('refuses to resize the desk itself', () => {
    const result = planLayout(
      start,
      [{ op: 'resize', targets: ['region:main'], size: { kind: 'preset', preset: 'small' } }],
      e
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('"in a row" still leaves the desk full', () => {
    const state = run(
      start,
      [{ op: 'arrange', targets: null, scope: 'region:main', layout: 'row' }],
      e
    );
    expect(violations(state, e)).toEqual([]);
  });

  it('a region grouped on a desk takes a pane, and the desk stays full', () => {
    const state = run(
      start,
      [{ op: 'createRegion', name: 'Pair', members: ['agent:a0', 'agent:a1'] }],
      e
    );
    expect(Object.keys(state.regions)).toHaveLength(2);
    expect(violations(state, e)).toEqual([]);
  });

  it('a new desk is full from the start, and a window moved to it leaves both full', () => {
    const made = run(start, [{ op: 'createRegion', name: 'Review', members: [], parent: null }], e);
    const review = Object.keys(made.regions).find((id) => id !== 'region:main') as string;
    expect(violations(made, e)).toEqual([]);
    const moved = run(
      made,
      [{ op: 'move', targets: ['agent:a0'], to: { kind: 'region', region: review } }],
      e
    );
    expect(violations(moved, e)).toEqual([]);
  });

  it('desks hold their places on the board rather than pushing each other', () => {
    const many = [...agents(9)];
    const env9 = env(many);
    const two: LayoutState = {
      ...looseDesk(many),
      regions: {
        'region:main': region('Main'),
        'region:below': region('Below', { rect: { x: 0, y: 1400, w: 900, h: 500 } }),
      },
    };
    const state = settleDesks(two, env9, ['region:main', 'region:below']);
    expect(state.regions['region:below']?.rect).toMatchObject({ x: 0, y: 1400 });
    expect(violations(state, env9)).toEqual([]);
  });
});

// ── Whatever is asked of a desk, it holds the rules ─────────────────────────

/** A small seeded generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the desk rules hold under any sequence of changes', () => {
  const ALL = [...agents(9), 'browser:b0', 'browser:b1', 'note:n0', 'note:n1', 'doc:d0'];
  const SCREENS: DeskScreen[] = [
    { width: 1600, height: 900 },
    { width: 1280, height: 720 },
    { width: 2560, height: 1380 },
    { width: 900, height: 1300 },
  ];

  function randomOp(next: () => number, state: LayoutState): LayoutOp {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const regions = Object.keys(state.regions);
    const desks = regions.filter((id) => parentOf(state, id) === null);
    const node = () => (next() < 0.85 || regions.length === 0 ? pick(ALL) : pick(regions));
    const kind = Math.floor(next() * 16);
    switch (kind) {
      case 0:
        return { op: 'move', targets: [node()], to: { kind: 'region', region: pick(regions) } };
      case 1: {
        const id = pick(ALL);
        const region = parentOf(state, id);
        const box = state.regions[region ?? '']?.rect ?? { x: 0, y: 0, w: 1000, h: 800 };
        return {
          op: 'move',
          targets: [id],
          to: {
            kind: 'exact',
            x: Math.round(box.x + next() * box.w),
            y: Math.round(box.y + next() * box.h),
            region: next() < 0.8 ? region : pick(regions),
          },
        };
      }
      case 2:
        return {
          op: 'move',
          targets: [node()],
          to: {
            kind: 'nudge',
            direction: pick(['left', 'right', 'up', 'down'] as const),
            amount: pick(['bit', 'some', 'far'] as const),
          },
        };
      case 3:
        return {
          op: 'move',
          targets: [pick(ALL)],
          to: {
            kind: 'slot',
            slot: pick(['top-left', 'center', 'bottom-right', 'right'] as const),
          },
        };
      case 4:
        return {
          op: 'move',
          targets: [pick(ALL)],
          to: {
            kind: 'relative',
            anchor: pick(ALL),
            side: pick(['left', 'right', 'above', 'below'] as const),
          },
        };
      case 5: {
        const id = pick(ALL);
        const rect = state.tiles[id] ?? { x: 0, y: 0, w: 400, h: 300 };
        return {
          op: 'resize',
          targets: [id],
          size: {
            kind: 'exact',
            rect: { ...rect, w: rect.w * (0.4 + next() * 2), h: rect.h * (0.4 + next() * 2) },
          },
        };
      }
      case 6:
        return {
          op: 'resize',
          targets: [node()],
          size: {
            kind: 'relative',
            axis: pick(['both', 'width', 'height'] as const),
            factor: pick(['bit', 'more', 'much', 'double', 'half'] as const),
            direction: pick(['grow', 'shrink'] as const),
          },
        };
      case 7:
        return {
          op: 'resize',
          targets: [node()],
          size:
            next() < 0.5
              ? { kind: 'preset', preset: pick(['small', 'large', 'wide', 'default'] as const) }
              : { kind: 'screen', fraction: pick(['half', 'full'] as const), axis: 'both' },
        };
      case 8:
        return {
          op: 'arrange',
          targets: null,
          scope: pick(regions),
          layout: pick(['grid', 'row', 'column', 'tidy', 'tile'] as const),
        };
      case 9:
        return { op: 'swap', a: pick(ALL), b: pick(ALL) };
      case 10:
        return { op: 'hide', targets: [pick(ALL)] };
      case 11:
        return { op: 'show', targets: [pick(ALL)] };
      case 12:
        return {
          op: 'createRegion',
          members: [pick(ALL), pick(ALL)],
          ...(next() < 0.3 ? { parent: null } : {}),
        };
      case 13:
        return desks.length > 1 || regions.length > desks.length
          ? {
              op: 'dissolveRegion',
              region: pick(regions.filter((id) => desks.length > 1 || !desks.includes(id))),
              ...(next() < 0.5 ? { into: pick(desks) } : {}),
            }
          : { op: 'fitRegion', region: pick(regions) };
      case 14: {
        const nested = regions.filter((id) => !desks.includes(id));
        return nested.length > 0
          ? { op: 'collapseRegion', region: pick(nested), collapsed: next() < 0.6 }
          : { op: 'fitRegion', region: pick(regions) };
      }
      default:
        return { op: 'fitRegion', region: pick(regions) };
    }
  }

  for (const seed of Array.from({ length: 24 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, () => {
      const next = random(seed);
      const screen = SCREENS[seed % SCREENS.length] as DeskScreen;
      const e = env(ALL, { screen, frameAllowance: seed % 3 === 0 ? 36 : 0 });
      let state = settleDesks(looseDesk(ALL), e, ['region:main']);
      expect(violations(state, e)).toEqual([]);
      for (let step = 0; step < 150; step++) {
        const op = randomOp(next, state);
        const result = planLayout(state, [op], e);
        if (!result.ok) continue;
        state = result.plan.state;
        // A window on no desk is homed by the store; here it simply goes back to the first desk.
        const loose = ALL.filter((id) => parentOf(state, id) === null && !isRegionId(id));
        if (loose.length > 0) {
          const home = Object.keys(state.regions).find((id) => parentOf(state, id) === null);
          const homed = planLayout(
            state,
            [{ op: 'move', targets: loose, to: { kind: 'region', region: home ?? null } }],
            e
          );
          if (homed.ok) state = homed.plan.state;
        }
        const found = violations(state, e);
        expect(`${found.join('; ')}`, `after step ${step}: ${JSON.stringify(op)}`).toBe('');
        // What the planner leaves is what a repair would make: nothing to repair.
        const desks = Object.keys(state.regions).filter((id) => parentOf(state, id) === null);
        expect(changes(state, settleDesks(state, e, desks)), `refit after step ${step}`).toEqual(
          []
        );
      }
    });
  }
});
