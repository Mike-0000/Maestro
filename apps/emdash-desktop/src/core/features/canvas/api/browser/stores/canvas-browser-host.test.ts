import { describe, expect, it, vi } from 'vitest';
import type { BrowserEvent } from '@core/primitives/browser/api';
import { CanvasBrowserHost } from './canvas-browser-host';
import type { CanvasStore } from './canvas-store';

vi.mock('@emdash/ui/react/primitives', () => ({ toast: vi.fn() }));

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

  it('brings a leased canvas tile back', () => {
    const browsers = host(['tile-1']);
    browsers['handleEvent'](lease('tile-1'));
    expect(browsers.alive).toEqual(['tile-1']);
  });
});
