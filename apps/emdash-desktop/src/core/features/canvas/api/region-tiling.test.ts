import { describe, expect, it } from 'vitest';
import { browsersToSuspend } from './canvas-model';
import type { LayoutState, RegionState } from './canvas-regions';
import {
  adjacentRegion,
  cameraLeftRegion,
  frameViewport,
  peerRegions,
  planTiling,
  promotedTiles,
  tilingTree,
  WORKSPACE_INSETS,
  workspaceSize,
  type TilingItem,
} from './region-tiling';
import { leafOrder, type SplitNode } from './stage-layout';

const agent = (id: string, weight = 1): TilingItem => ({
  id,
  weight,
  min: { w: 360, h: 220 },
});

describe('tilingTree', () => {
  it('puts two windows side by side on a landscape area and stacks them on a portrait one', () => {
    expect(tilingTree([agent('a'), agent('b')], 1.8)).toMatchObject({ axis: 'row' });
    expect(tilingTree([agent('a'), agent('b')], 0.7)).toMatchObject({ axis: 'column' });
  });

  it('gives the heaviest of three the main pane', () => {
    const tree = tilingTree([agent('a'), agent('b'), agent('browser', 1.5)], 1.8) as Extract<
      SplitNode,
      { type: 'split' }
    >;
    expect(tree.children[0]).toEqual({ type: 'leaf', tileId: 'browser' });
    expect(tree.ratios[0]).toBeCloseTo(0.6, 5);
    expect(leafOrder(tree)).toEqual(['browser', 'a', 'b']);
  });

  it('makes four windows quadrants and more into balanced rows', () => {
    const four = tilingTree(
      ['a', 'b', 'c', 'd'].map((id) => agent(id)),
      1.8
    );
    expect(four).toMatchObject({ axis: 'column', ratios: [0.5, 0.5] });
    const six = tilingTree(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => agent(id)),
      1.8
    ) as Extract<SplitNode, { type: 'split' }>;
    expect(six.children).toHaveLength(2);
  });
});

describe('planTiling', () => {
  it('gives each pane an area proportional to its weight', () => {
    const tiling = planTiling(
      [agent('a'), agent('b'), agent('c'), agent('browser', 1.5)],
      { w: 1500, h: 900 },
      0
    );
    const area = (id: string) => {
      const pane = tiling.panes.find((p) => p.tileId === id)!;
      return pane.rect.w * pane.rect.h;
    };
    expect(area('browser') / area('a')).toBeCloseTo(1.5, 5);
    const total = tiling.panes.reduce((sum, pane) => sum + pane.rect.w * pane.rect.h, 0);
    expect(total).toBeCloseTo(1500 * 900, 0);
  });

  it('grows the area, keeping its shape, until every pane meets its minimum', () => {
    const items = Array.from({ length: 12 }, (_, i) => agent(`a${i}`));
    const tiling = planTiling(items, { w: 1000, h: 500 }, 24);
    expect(tiling.area.w).toBeGreaterThan(1000);
    expect(tiling.area.w / tiling.area.h).toBeCloseTo(2, 1);
    for (const pane of tiling.panes) {
      expect(pane.rect.w).toBeGreaterThanOrEqual(359.5);
      expect(pane.rect.h).toBeGreaterThanOrEqual(219.5);
    }
  });
});

describe('workspace framing', () => {
  const screen = { width: 1600, height: 900 };

  it('frames a workspace-sized region at exactly zoom 1', () => {
    const size = workspaceSize(screen);
    const view = frameViewport({ x: 500, y: 300, ...size }, screen);
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(WORKSPACE_INSETS.left - 500);
    expect(view.y).toBe(WORKSPACE_INSETS.top - 300);
  });

  it('zooms out to fit a larger region and never zooms in past 1', () => {
    expect(frameViewport({ x: 0, y: 0, w: 3136, h: 1656 }, screen).zoom).toBeCloseTo(0.5, 2);
    expect(frameViewport({ x: 0, y: 0, w: 400, h: 300 }, screen).zoom).toBe(1);
  });

  it('snaps a hair under 1 to 1 so terminals stay interactive', () => {
    const size = workspaceSize(screen);
    expect(frameViewport({ x: 0, y: 0, w: size.w + 10, h: size.h }, screen).zoom).toBe(1);
  });
});

describe('cameraLeftRegion', () => {
  const region = { x: 0, y: 0, w: 1568, h: 828 };

  it('stays in a region for small pans and zooms', () => {
    expect(cameraLeftRegion({ x: 100, y: 50, w: 1600, h: 900 }, region)).toBe(false);
    expect(cameraLeftRegion({ x: -400, y: -200, w: 2400, h: 1350 }, region)).toBe(false);
  });

  it('leaves when the region is mostly panned away', () => {
    expect(cameraLeftRegion({ x: 1300, y: 0, w: 1600, h: 900 }, region)).toBe(true);
  });

  it('leaves when zoomed far out to the wider board', () => {
    expect(cameraLeftRegion({ x: -3000, y: -2000, w: 8000, h: 4500 }, region)).toBe(true);
  });

  it('measures zooming out from the zoom a small region was framed at', () => {
    const small = { x: 600, y: 300, w: 500, h: 300 };
    const framed = { current: 1, framed: 1 };
    expect(cameraLeftRegion({ x: 0, y: 0, w: 1600, h: 900 }, small, framed)).toBe(false);
    const out = { current: 0.4, framed: 1 };
    expect(cameraLeftRegion({ x: -1000, y: -700, w: 4000, h: 2250 }, small, out)).toBe(true);
  });
});

describe('render promotion', () => {
  it('never suspends a pinned browser and demotes it once unpinned', () => {
    const alive = ['browser:a', 'browser:b', 'browser:c'];
    const lastUsed = new Map([
      ['browser:a', 1],
      ['browser:b', 2],
      ['browser:c', 3],
    ]);
    const pinned = new Set(['browser:a']);
    expect(browsersToSuspend({ alive, lastUsed, leased: new Set(), pinned, budget: 1 })).toEqual([
      'browser:c',
      'browser:b',
    ]);
    expect(browsersToSuspend({ alive, lastUsed, leased: new Set(), budget: 1 })).toEqual([
      'browser:b',
      'browser:a',
    ]);
  });
});

const regionAt = (x: number, y: number, extra: Partial<RegionState> = {}): RegionState => ({
  name: 'R',
  parentId: null,
  rect: { x, y, w: 800, h: 500 },
  collapsed: false,
  createdAt: 0,
  ...extra,
});

describe('promotedTiles', () => {
  const tile = { x: 0, y: 0, w: 400, h: 300 };
  const state: LayoutState = {
    tiles: { a: tile, b: tile, c: tile, n: tile, out: tile, gone: tile },
    regions: {
      'region:top': regionAt(0, 0),
      'region:inner': regionAt(0, 0, { parentId: 'region:top' }),
      'region:folded': regionAt(0, 0, { parentId: 'region:top', collapsed: true }),
    },
    membership: {
      a: 'region:top',
      b: 'region:inner',
      c: 'region:top',
      n: 'region:folded',
      gone: 'region:top',
    },
    hidden: ['gone'],
  };
  const visible = new Set(['a', 'b', 'c', 'n', 'out']);
  const rank = (id: string) => (id === 'c' ? 0 : 5);

  it('promotes every drawn window of the region and its nested regions, best-ranked first', () => {
    expect(promotedTiles(state, 'region:top', visible, rank)).toEqual(['c', 'a', 'b']);
  });

  it('skips closed windows, folded-away ones, and windows outside the region', () => {
    const promoted = promotedTiles(state, 'region:top', visible, rank);
    expect(promoted).not.toContain('gone');
    expect(promoted).not.toContain('n');
    expect(promoted).not.toContain('out');
  });

  it('caps how many go live and promotes nothing without a focused, open region', () => {
    expect(promotedTiles(state, 'region:top', visible, rank, 2)).toEqual(['c', 'a']);
    expect(promotedTiles(state, null, visible, rank)).toEqual([]);
    expect(promotedTiles(state, 'region:folded', visible, rank)).toEqual([]);
    expect(promotedTiles(state, 'region:missing', visible, rank)).toEqual([]);
  });
});

describe('adjacentRegion', () => {
  const state: LayoutState = {
    tiles: {},
    regions: {
      'region:c': regionAt(0, 900),
      'region:b': regionAt(1000, 0),
      'region:a': regionAt(0, 40),
      'region:child': regionAt(0, 40, { parentId: 'region:a' }),
    },
    membership: {},
    hidden: [],
  };

  it('orders regions at one level in reading order', () => {
    expect(peerRegions(state, null)).toEqual(['region:a', 'region:b', 'region:c']);
    expect(peerRegions(state, 'region:b')).toEqual(['region:a', 'region:b', 'region:c']);
  });

  it('steps forward and back, wrapping around', () => {
    expect(adjacentRegion(state, 'region:a', 1)).toBe('region:b');
    expect(adjacentRegion(state, 'region:c', 1)).toBe('region:a');
    expect(adjacentRegion(state, 'region:a', -1)).toBe('region:c');
  });

  it('starts from the first or last region on the main canvas', () => {
    expect(adjacentRegion(state, null, 1)).toBe('region:a');
    expect(adjacentRegion(state, null, -1)).toBe('region:c');
  });

  it('has nowhere to go from an only child', () => {
    expect(adjacentRegion(state, 'region:child', 1)).toBeNull();
  });
});
