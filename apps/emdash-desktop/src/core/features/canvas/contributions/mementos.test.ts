import { describe, expect, it } from 'vitest';
import { canvasBoardSchema, DEFAULT_LAYOUT_SETTINGS } from './mementos';

const v2 = {
  version: '2',
  viewport: { x: 0, y: 0, zoom: 1 },
  tiles: { 'agent:c1': { x: 0, y: 0, w: 480, h: 360 } },
  notes: {},
  spokenNames: { c1: 'Atlas' },
  hiddenConversationIds: [],
  projectFilter: null,
  openOnLaunch: true,
  showTaskFrames: false,
};

const v4Defaults = {
  regions: {},
  membership: {},
  hiddenTiles: [],
  stageLayouts: {},
  location: { kind: 'board', regionScope: null },
  layoutSettings: DEFAULT_LAYOUT_SETTINGS,
};

describe('canvasBoardSchema', () => {
  it('upgrades v2 boards with no app browsers and no regions', () => {
    expect(canvasBoardSchema.safeParse(v2)).toEqual({
      status: 'ok',
      data: { ...v2, ...v4Defaults, version: '5', mode: 'classic', browsers: {} },
    });
  });

  it('keeps v4 regions, membership, stage layouts, and location', () => {
    const v4 = {
      ...v2,
      ...v4Defaults,
      version: '4',
      browsers: {},
      regions: {
        'region:r1': {
          name: 'Review',
          parentId: null,
          rect: { x: 0, y: 0, w: 800, h: 600 },
          collapsed: false,
          color: 'blue',
          createdAt: 1,
        },
      },
      membership: { 'agent:c1': 'region:r1' },
      stageLayouts: {
        'region:r1': {
          order: ['agent:c1'],
          trees: {
            'agent:c1|agent:c2': {
              type: 'split',
              axis: 'row',
              ratios: [0.7, 0.3],
              children: [
                { type: 'leaf', tileId: 'agent:c1' },
                { type: 'leaf', tileId: 'agent:c2' },
              ],
            },
          },
          soloTileId: null,
        },
      },
      location: {
        kind: 'stage',
        target: { kind: 'region', regionId: 'region:r1' },
        page: 0,
        immersive: false,
      },
    };
    expect(canvasBoardSchema.safeParse(v4)).toEqual({
      status: 'ok',
      data: { ...v4, version: '5', mode: 'classic' },
    });
  });

  it('keeps the canvas mode, desk order, and gathering desks', () => {
    const v5 = {
      ...v2,
      ...v4Defaults,
      version: '5',
      mode: 'pro',
      browsers: {},
      regions: {
        'region:r1': {
          name: 'Triage',
          parentId: null,
          rect: { x: 0, y: 0, w: 800, h: 600 },
          collapsed: false,
          createdAt: 1,
          order: 2,
          gather: 'needs-you',
        },
      },
      location: { kind: 'board', regionScope: 'region:r1' },
    };
    expect(canvasBoardSchema.safeParse(v5)).toEqual({ status: 'ok', data: v5 });
    const badMode = { ...v5, mode: 'spaces' };
    expect(canvasBoardSchema.safeParse(badMode).status).not.toBe('ok');
  });

  it('keeps v3 browsers', () => {
    const v3 = {
      ...v2,
      version: '3',
      browsers: {
        t1: {
          projectId: 'p1',
          workspaceId: 'w1',
          url: 'http://localhost:5173/',
          control: 'agents',
        },
      },
    };
    expect(canvasBoardSchema.safeParse(v3)).toEqual({
      status: 'ok',
      data: { ...v3, ...v4Defaults, version: '5', mode: 'classic' },
    });
  });

  it('defaults placeNewWindowsInProjectRegion on older layout settings', () => {
    const v4 = {
      ...v2,
      ...v4Defaults,
      version: '4',
      browsers: {},
      layoutSettings: {
        showNamesWhileListening: true,
        speakLayoutConfirmations: false,
        groupPlanAgents: true,
        placeNewAgentsInCurrentRegion: true,
      },
    };
    const parsed = canvasBoardSchema.safeParse(v4);
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.data.layoutSettings.placeNewWindowsInProjectRegion).toBe(true);
    }
  });

  it('keeps multi-canvas views and rejects more than four', () => {
    const v4 = {
      ...v2,
      ...v4Defaults,
      version: '4',
      browsers: {},
      panes: {
        count: 2,
        active: 1,
        views: [
          { viewport: { x: 0, y: 0, zoom: 1 }, regionScope: null },
          { viewport: { x: -400, y: 20, zoom: 0.5 }, regionScope: 'region:r1' },
        ],
      },
    };
    expect(canvasBoardSchema.safeParse(v4)).toEqual({
      status: 'ok',
      data: { ...v4, version: '5', mode: 'classic' },
    });
    const tooMany = { ...v4, panes: { ...v4.panes, count: 5 } };
    expect(canvasBoardSchema.safeParse(tooMany).status).not.toBe('ok');
  });

  it('rejects an unknown control value', () => {
    const bad = {
      ...v2,
      version: '3',
      browsers: { t1: { projectId: 'p1', workspaceId: 'w1', url: 'x', control: 'everyone' } },
    };
    expect(canvasBoardSchema.safeParse(bad).status).not.toBe('ok');
  });
});
