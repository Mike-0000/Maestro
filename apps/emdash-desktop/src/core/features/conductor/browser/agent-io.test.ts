import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { sendToAgent, sendToLiveSession } from './agent-io';

const mocks = vi.hoisted(() => ({
  sendInput: vi.fn(),
  registryGet: vi.fn(),
  readTerminalTail: vi.fn((): string[] => []),
}));

vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({ tui: { sendInput: mocks.sendInput } }),
}));
vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: { get: mocks.registryGet },
}));
vi.mock('@core/features/canvas/api/browser/terminal-tail', () => ({
  readTerminalTail: mocks.readTerminalTail,
}));

const ok = { success: true as const, data: undefined };
const refused = (type: string) => ({ success: false as const, error: { type } });

function entry(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    conversationId: 'conv-1',
    taskName: 'echo task',
    providerId: 'claude',
    type: 'pty',
    sessionActive: false,
    ...overrides,
  } as AgentTileEntry;
}

beforeEach(() => {
  mocks.sendInput.mockReset();
  mocks.sendInput.mockResolvedValue(ok);
  mocks.readTerminalTail.mockReset();
  mocks.readTerminalTail.mockReturnValue([]);
  mocks.registryGet.mockReset();
  mocks.registryGet.mockReturnValue({
    sessions: new Map([['conv-1', { connect: async () => {}, pty: { terminal: {} } }]]),
  });
});

const enters = () => mocks.sendInput.mock.calls.filter(([input]) => input.data === '\r').length;

describe('sendToLiveSession', () => {
  it('pastes and submits when the host still has the session', async () => {
    await expect(sendToLiveSession(entry(), 'hello')).resolves.toBe(true);

    expect(mocks.sendInput).toHaveBeenCalledTimes(2);
    expect(mocks.sendInput.mock.calls[0]?.[0].data).toContain('hello');
    expect(mocks.sendInput.mock.calls[1]?.[0]).toEqual({ conversationId: 'conv-1', data: '\r' });
  });

  it('presses Enter again when Codex read the first one as part of the paste', async () => {
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(150);
      expect(enters()).toBe(0);

      await vi.advanceTimersByTimeAsync(400);
      expect(enters()).toBe(1);

      mocks.readTerminalTail.mockReturnValue(['• Working (0s • esc to interrupt)']);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(enters()).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries Enter for Codex until the turn starts, at most three times', async () => {
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('presses Enter once for Codex when its screen cannot be read', async () => {
    mocks.registryGet.mockReturnValue(undefined);
    vi.useFakeTimers();
    try {
      const sent = sendToLiveSession(entry({ providerId: 'codex' }), 'hello');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(sent).resolves.toBe(true);
      expect(enters()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves false, having typed nothing, when the host has no such session', async () => {
    mocks.sendInput.mockResolvedValue(refused('not-found'));

    await expect(sendToLiveSession(entry(), 'hello')).resolves.toBe(false);
    expect(mocks.sendInput).toHaveBeenCalledTimes(1);
  });

  it('throws on any other refusal instead of starting a second agent', async () => {
    mocks.sendInput.mockResolvedValue(refused('runtime-unavailable'));

    await expect(sendToLiveSession(entry(), 'hello')).rejects.toThrow('runtime-unavailable');
  });

  it('leaves chat agents to the ordinary path', async () => {
    await expect(sendToLiveSession(entry({ type: 'acp' }), 'hello')).resolves.toBe(false);
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });
});

describe('sendToAgent', () => {
  it('still refuses a terminal agent the session list calls stopped', async () => {
    await expect(sendToAgent(entry(), 'hello')).rejects.toThrow('is not running');
    expect(mocks.sendInput).not.toHaveBeenCalled();
  });
});
