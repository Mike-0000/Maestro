import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { deliverPromptWhenReady } from './deferred-prompt';

// A prompt that waits for an agent to start: typed once the session list shows the session, and
// offered to the host itself before giving up, because the list can trail the host.

const mocks = vi.hoisted(() => ({
  sendToAgent: vi.fn(async () => {}),
  sendToLiveSession: vi.fn(async () => false),
}));

vi.mock('./agent-io', () => ({
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: mocks.sendToLiveSession,
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function canvasWith(entry: Partial<AgentTileEntry> | null): CanvasStore {
  const entries = entry ? [{ conversationId: 'conv-1', type: 'pty', ...entry }] : [];
  return { agentEntries: entries, visibleAgentEntries: entries } as unknown as CanvasStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('deliverPromptWhenReady', () => {
  it('types the prompt once the session is listed as running', async () => {
    const delivery = deliverPromptWhenReady(canvasWith({ sessionActive: true }), 'conv-1', 'go');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await delivery).toBe(true);
    expect(mocks.sendToAgent).toHaveBeenCalledOnce();
    expect(mocks.sendToLiveSession).not.toHaveBeenCalled();
  });

  it('asks the host before giving up on a session the list never showed', async () => {
    mocks.sendToLiveSession.mockResolvedValueOnce(true);
    const delivery = deliverPromptWhenReady(canvasWith({ sessionActive: false }), 'conv-1', 'go');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await delivery).toBe(true);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.sendToLiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      'go',
      true
    );
  });

  it('reports failure when the host has no session either', async () => {
    const delivery = deliverPromptWhenReady(canvasWith({ sessionActive: false }), 'conv-1', 'go');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await delivery).toBe(false);
  });

  it('reports failure for an agent that left the canvas', async () => {
    const delivery = deliverPromptWhenReady(canvasWith(null), 'conv-1', 'go');
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await delivery).toBe(false);
    expect(mocks.sendToLiveSession).not.toHaveBeenCalled();
  });
});
