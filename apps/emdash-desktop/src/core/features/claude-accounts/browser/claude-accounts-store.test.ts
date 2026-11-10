import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccountsRpcClient } from '../api/browser/client';
import type {
  ClaudeAccount,
  ClaudeAccountsEvent,
  ClaudeAccountsState,
  ClaudeAccountUsage,
} from '../api/types';
import { ClaudeAccountsStore, USAGE_POLL_MS } from './claude-accounts-store';

const primary: ClaudeAccount = { id: 'primary', label: 'Primary', kind: 'primary', loggedIn: true };
const work: ClaudeAccount = { id: 'work', label: 'Work', kind: 'extra', loggedIn: true };

function fresh(accountId: string, usedPercent = 40): ClaudeAccountUsage {
  return {
    accountId,
    status: 'fresh',
    snapshot: {
      fetchedAt: new Date(0).toISOString(),
      subscriptionType: 'max',
      fiveHour: null,
      sevenDay: { usedPercent, resetsAt: null },
      sevenDayOpus: null,
      sevenDaySonnet: null,
      limits: [],
    },
  };
}

function signedOut(accountId: string): ClaudeAccountUsage {
  return { accountId, status: 'unavailable', snapshot: null, reason: 'not-logged-in' };
}

function createHarness(
  initial: ClaudeAccountsState = { accounts: [primary, work], defaultAccountId: 'primary' }
) {
  let state = initial;
  let usage: ClaudeAccountUsage[] = initial.accounts.map((account) => fresh(account.id));
  let onEvent: ((event: ClaudeAccountsEvent) => void) | undefined;
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const unsubscribe = vi.fn();

  const client = {
    list: vi.fn(async () => state),
    create: vi.fn(async ({ label }: { label: string }) => ({
      success: true as const,
      data: { id: 'new', label, kind: 'extra', loggedIn: false } satisfies ClaudeAccount,
    })),
    rename: vi.fn(async ({ accountId, label }: { accountId: string; label: string }) => ({
      success: true as const,
      data: { ...work, id: accountId, label },
    })),
    remove: vi.fn(async (_input: { accountId: string }) => ({
      success: true as const,
      data: undefined,
    })),
    setDefault: vi.fn(async (_input: { accountId: string }) => ({
      success: true as const,
      data: undefined,
    })),
    refreshIdentity: vi.fn(async ({ accountId }: { accountId: string }) => ({
      success: true as const,
      data: {
        ...(state.accounts.find((account) => account.id === accountId) ?? work),
        loggedIn: true,
      },
    })),
    usage: vi.fn(async (_input: { force?: boolean }) => usage),
    events: {
      subscribe: vi.fn(
        async (_key: undefined, options: { onEvent: (event: ClaudeAccountsEvent) => void }) => {
          onEvent = options.onEvent;
          return unsubscribe;
        }
      ),
    },
  };

  const store = new ClaudeAccountsStore({
    getClient: async () => client as unknown as ClaudeAccountsRpcClient,
    now: () => Date.now(),
    isWindowVisible: () => visible,
    onWindowVisibilityChange: (listener) => {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  });

  return {
    store,
    client,
    unsubscribe,
    setServerState(next: ClaudeAccountsState) {
      state = next;
    },
    setUsage(next: ClaudeAccountUsage[]) {
      usage = next;
    },
    emit(next: ClaudeAccountsState) {
      state = next;
      onEvent?.({ type: 'changed', state: next });
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibilityListeners) listener();
    },
    visibilityListenerCount: () => visibilityListeners.size,
  };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('ClaudeAccountsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 10, 9, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the accounts, follows changes, and fetches usage once on start', async () => {
    const { store, client } = createHarness();

    store.start();
    await settle();

    expect(client.events.subscribe).toHaveBeenCalledTimes(1);
    expect(store.accounts.map((account) => account.id)).toEqual(['primary', 'work']);
    expect(store.defaultAccountId).toBe('primary');
    expect(store.hasMultipleAccounts).toBe(true);
    expect(client.usage).toHaveBeenCalledTimes(1);
    expect(client.usage).toHaveBeenCalledWith({});
    expect(store.usage.get('work')?.status).toBe('fresh');
    expect(store.usageCheckedAt).toBe(Date.now());
    expect(store.usageLoading).toBe(false);
  });

  it('assumes the primary account before anything has loaded', () => {
    const { store } = createHarness();

    expect(store.state).toBeNull();
    expect(store.accounts).toEqual([]);
    expect(store.defaultAccountId).toBe('primary');
    expect(store.hasAnySignIn).toBe(false);
  });

  it('takes the whole state from a change event and drops usage of removed accounts', async () => {
    const { store, emit } = createHarness();
    store.start();
    await settle();

    emit({ accounts: [primary], defaultAccountId: 'primary' });

    expect(store.accounts).toEqual([primary]);
    expect(store.hasMultipleAccounts).toBe(false);
    expect(store.usage.has('work')).toBe(false);
  });

  it('fetches usage when an event brings an account it has no usage for', async () => {
    const { store, client, emit, setUsage } = createHarness({
      accounts: [primary],
      defaultAccountId: 'primary',
    });
    store.start();
    await settle();
    expect(client.usage).toHaveBeenCalledTimes(1);

    setUsage([fresh('primary'), signedOut('work')]);
    emit({ accounts: [primary, { ...work, loggedIn: false }], defaultAccountId: 'primary' });
    await settle();

    expect(client.usage).toHaveBeenCalledTimes(2);
    expect(store.usage.get('work')?.reason).toBe('not-logged-in');
  });

  it('applies its own changes without waiting for the event', async () => {
    const { store } = createHarness();
    store.start();
    await settle();

    await store.setDefault('work');
    expect(store.defaultAccountId).toBe('work');

    await store.rename('work', 'Client');
    expect(store.account('work')?.label).toBe('Client');

    const created = await store.create('Spare');
    expect(created.success).toBe(true);
    expect(store.accounts.map((account) => account.id)).toEqual(['primary', 'work', 'new']);

    await store.remove('work');
    expect(store.accounts.map((account) => account.id)).toEqual(['primary', 'new']);
    // Removing the default falls back to the primary account, as the backend does.
    expect(store.defaultAccountId).toBe('primary');
  });

  it('leaves the state alone when a change is refused', async () => {
    const { store, client } = createHarness();
    store.start();
    await settle();
    client.setDefault.mockResolvedValueOnce({
      success: false,
      error: { type: 'not-found', accountId: 'gone' },
    } as never);

    const result = await store.setDefault('gone');

    expect(result.success).toBe(false);
    expect(store.defaultAccountId).toBe('primary');
  });

  it('shares one usage request between callers, and forces when asked', async () => {
    const { store, client } = createHarness();
    store.start();
    await settle();
    client.usage.mockClear();

    const first = store.refreshUsage();
    const second = store.refreshUsage();
    expect(store.usageLoading).toBe(true);
    await Promise.all([first, second]);
    expect(client.usage).toHaveBeenCalledTimes(1);
    expect(store.usageLoading).toBe(false);

    await store.refreshUsage({ force: true });
    expect(client.usage).toHaveBeenLastCalledWith({ force: true });
  });

  it('keeps the last numbers when a usage fetch fails', async () => {
    const { store, client } = createHarness();
    store.start();
    await settle();
    client.usage.mockRejectedValueOnce(new Error('offline'));

    await store.refreshUsage({ force: true });

    expect(store.usage.get('primary')?.status).toBe('fresh');
    expect(store.usageLoading).toBe(false);
  });

  it('polls every five minutes only while a surface watches and the window is visible', async () => {
    const { store, client, setVisible, visibilityListenerCount } = createHarness();
    store.start();
    await settle();
    client.usage.mockClear();

    // Nothing watching: no polling.
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2);
    expect(client.usage).not.toHaveBeenCalled();

    // Opening a surface refreshes numbers older than a minute, then polls.
    const stopFirst = store.watchUsage();
    const stopSecond = store.watchUsage();
    await settle();
    expect(client.usage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(client.usage).toHaveBeenCalledTimes(2);

    // Hidden window: the poll is skipped, and coming back catches up at once.
    setVisible(false);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(client.usage).toHaveBeenCalledTimes(2);
    setVisible(true);
    await settle();
    expect(client.usage).toHaveBeenCalledTimes(3);

    // One surface left keeps the poll alive; closing the last one stops it.
    stopFirst();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(client.usage).toHaveBeenCalledTimes(4);
    stopSecond();
    stopSecond();
    expect(visibilityListenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2);
    expect(client.usage).toHaveBeenCalledTimes(4);
  });

  it('does not refetch when a surface opens right after a fetch', async () => {
    const { store, client } = createHarness();
    store.start();
    await settle();
    client.usage.mockClear();

    const stop = store.watchUsage();
    await vi.advanceTimersByTimeAsync(10_000);
    // The start-up fetch was moments ago.
    expect(client.usage).not.toHaveBeenCalled();
    stop();
  });

  it('counts usage as proof of a sign-in and asks Claude Code once to catch up', async () => {
    const stalePrimary = { ...primary, loggedIn: false };
    const { store, client } = createHarness({
      accounts: [stalePrimary, work],
      defaultAccountId: 'primary',
    });

    store.start();
    await settle();

    expect(store.isSignedIn(stalePrimary)).toBe(true);
    expect(client.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(client.refreshIdentity).toHaveBeenCalledWith({ accountId: 'primary' });
    expect(store.account('primary')?.loggedIn).toBe(true);

    await store.refreshUsage({ force: true });
    expect(client.refreshIdentity).toHaveBeenCalledTimes(1);
  });

  it('treats a missing sign-in on disk as signed out', async () => {
    const { store, setUsage } = createHarness();
    setUsage([fresh('primary'), signedOut('work')]);

    store.start();
    await settle();

    expect(store.isSignedIn(work)).toBe(false);
    expect(store.hasAnySignIn).toBe(true);
  });

  it('stops listening when disposed', async () => {
    const { store, unsubscribe, client } = createHarness();
    store.start();
    await settle();
    const stop = store.watchUsage();
    client.usage.mockClear();

    store.dispose();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.usage).not.toHaveBeenCalled();
    stop();
  });
});
