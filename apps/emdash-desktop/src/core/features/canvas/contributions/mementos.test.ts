import { describe, expect, it } from 'vitest';
import { canvasBoardSchema } from './mementos';

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

describe('canvasBoardSchema', () => {
  it('upgrades v2 boards with no app browsers', () => {
    expect(canvasBoardSchema.safeParse(v2)).toEqual({
      status: 'ok',
      data: { ...v2, version: '3', browsers: {} },
    });
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
    expect(canvasBoardSchema.safeParse(v3)).toEqual({ status: 'ok', data: v3 });
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
