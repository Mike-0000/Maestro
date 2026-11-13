import { describe, expect, it, vi } from 'vitest';
import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import { browserUserOrigins } from '@core/features/browser/api/browser/browser-user-origins';
import type { BrowserEvent } from '@core/primitives/browser/api';
import { CanvasBrowserHost } from './canvas-browser-host';
import type { CanvasStore } from './canvas-store';

vi.mock('@emdash/ui/react/primitives', () => ({ toast: vi.fn() }));

const client = vi.hoisted(() => ({
  registerSession: vi.fn(async () => ({ success: true })),
  setControl: vi.fn(async (_input: Record<string, unknown>) => ({
    success: true,
    data: undefined,
  })),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({
  getBrowserClient: async () => client,
}));

function lease(browserId: string): BrowserEvent {
  return {
    type: 'automation',
    browserId,
    actor: { kind: 'agent', conversationId: 'c1', name: 'Iris' },
    action: 'click',
    ok: true,
    leaseUntil: Date.now() + 60_000,
  };
}

function host(tileIds: string[]): CanvasBrowserHost {
  const canvas = {
    browserEntries: tileIds.map((browserId) => ({ browserId, taskId: `task-${browserId}` })),
  } as unknown as CanvasStore;
  return new CanvasBrowserHost(canvas);
}

describe('CanvasBrowserHost', () => {
  it("never mounts a task-view tab an agent drives as a second webview on the canvas's host", () => {
    const browsers = host(['tile-1']);
    browsers['handleEvent'](lease('tab-1'));
    expect(browsers.alive).toEqual([]);
  });

  it('allows only local origins the developer opened in a tile, not the page it shows', async () => {
    const entry = {
      browserId: 'tile-1',
      projectId: 'p1',
      workspaceId: 'w1',
      taskId: 't1',
      control: 'agents',
      // Where the tile is now: a page, the conductor or an agent took it there.
      url: 'http://localhost:5432/',
    };
    browserSessionStore.createSession({ ...entry, profileId: 'isolated-per-task' });
    const browsers = host([]);

    await browsers['syncControl'](entry as never);
    expect(client.setControl.mock.calls.at(-1)![0]).not.toHaveProperty('origins');

    browserUserOrigins.record('tile-1', 'http://localhost:4300/');
    await browsers['syncControl'](entry as never);
    expect(client.setControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ origins: ['http://localhost:4300'], surface: 'canvas' })
    );
  });

  it('brings a leased canvas tile back', () => {
    const browsers = host(['tile-1']);
    browsers['handleEvent'](lease('tile-1'));
    expect(browsers.alive).toEqual(['tile-1']);
  });
});
