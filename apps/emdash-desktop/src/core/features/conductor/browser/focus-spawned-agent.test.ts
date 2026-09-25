import { observable } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { focusSpawnedAgent } from './focus-spawned-agent';

describe('focusSpawnedAgent', () => {
  it('focuses the new tile after it appears and reveals it through any project filter', () => {
    const entries = observable.box<AgentTileEntry[]>([]);
    const canvas = {
      get agentEntries() {
        return entries.get();
      },
      ensureLayout: vi.fn(),
      revealConversation: vi.fn(),
      requestFocus: vi.fn(),
    } as unknown as CanvasStore;

    const dispose = focusSpawnedAgent(canvas, 'new-conversation');
    expect(canvas.requestFocus).not.toHaveBeenCalled();

    const other = { conversationId: 'other', tileId: 'agent:other' } as AgentTileEntry;
    const spawned = {
      conversationId: 'new-conversation',
      tileId: 'agent:new-conversation',
    } as AgentTileEntry;
    entries.set([other]);
    expect(canvas.requestFocus).not.toHaveBeenCalled();

    entries.set([other, spawned]);
    expect(canvas.ensureLayout).toHaveBeenCalledOnce();
    expect(canvas.revealConversation).toHaveBeenCalledWith(spawned);
    expect(canvas.requestFocus).toHaveBeenCalledWith(spawned.tileId);
    dispose();
  });
});
