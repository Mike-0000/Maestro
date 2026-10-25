import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installedProviders, forgetInstalledProviders } from './roster';

// Provider detection takes seconds on a real machine. A command spoken more than a minute after
// the last one must not wait for it: the last good answer is served while a new one is fetched.

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('@core/features/agents/api/browser/client', () => ({
  getAgentsClient: async () => ({ listAgentInstallationStatus: mocks.list }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ]),
}));

function available(...ids: string[]) {
  return { success: true, data: ids.map((id) => ({ id, status: 'available' })) };
}

beforeEach(() => {
  vi.useRealTimers();
  forgetInstalledProviders();
  mocks.list.mockReset();
});

describe('installedProviders', () => {
  it('waits for the first detection and shares one request between callers', async () => {
    mocks.list.mockResolvedValue(available('claude'));
    const [first, second] = await Promise.all([installedProviders(), installedProviders()]);
    expect(first).toEqual([{ id: 'claude', name: 'Claude Code' }]);
    expect(second).toEqual(first);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('serves the last answer at once after it expires, and refreshes behind it', async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue(available('claude'));
    await installedProviders();

    vi.setSystemTime(Date.now() + 61_000);
    let release: (value: unknown) => void = () => {};
    mocks.list.mockReturnValue(new Promise((resolve) => (release = resolve)));

    // The refresh has not answered, yet neither call waits for it.
    const stale = await installedProviders();
    const again = await installedProviders();
    expect(stale).toEqual([{ id: 'claude', name: 'Claude Code' }]);
    expect(again).toEqual(stale);
    expect(mocks.list).toHaveBeenCalledTimes(2);

    release(available('claude', 'codex'));
    await vi.waitFor(async () =>
      expect(await installedProviders()).toEqual([
        { id: 'claude', name: 'Claude Code' },
        { id: 'codex', name: 'Codex' },
      ])
    );
  });

  it('keeps the last answer when a later detection fails or finds nothing', async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue(available('claude'));
    await installedProviders();

    vi.setSystemTime(Date.now() + 61_000);
    mocks.list.mockResolvedValue({ success: false });
    expect(await installedProviders()).toEqual([{ id: 'claude', name: 'Claude Code' }]);
    await Promise.resolve();
    expect(await installedProviders()).toEqual([{ id: 'claude', name: 'Claude Code' }]);
  });
});
