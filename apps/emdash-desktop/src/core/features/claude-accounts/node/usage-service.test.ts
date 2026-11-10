import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeUsageSnapshot } from '../api/types';
import type { ClaudeUsageError } from './usage-client';
import { ClaudeUsageService, USAGE_CACHE_MS } from './usage-service';

const accounts = [
  { id: 'primary', configDir: '/home/ada/.claude' },
  { id: 'account-1', configDir: '/data/claude-accounts/account-1' },
];

function snapshot(fetchedAt: string): ClaudeUsageSnapshot {
  return {
    fetchedAt,
    subscriptionType: 'max',
    fiveHour: { usedPercent: 10, resetsAt: null },
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    limits: [],
  };
}

function setup(listed = accounts) {
  let now = 1_000_000;
  const fetchUsage = vi.fn(
    async (configDir: string) =>
      ok(snapshot(`${configDir}@${now}`)) as
        | ReturnType<typeof ok<ClaudeUsageSnapshot>>
        | {
            success: false;
            error: ClaudeUsageError;
          }
  );
  const service = new ClaudeUsageService({
    listAccounts: async () => listed,
    fetchUsage,
    now: () => now,
  });
  return { service, fetchUsage, advance: (ms: number) => (now += ms) };
}

describe('ClaudeUsageService', () => {
  it('answers for every account, primary first, each from its own folder', async () => {
    const { service, fetchUsage } = setup();

    const usage = await service.usage();

    expect(usage.map((entry) => [entry.accountId, entry.status])).toEqual([
      ['primary', 'fresh'],
      ['account-1', 'fresh'],
    ]);
    expect(usage[1]?.snapshot?.fetchedAt).toBe('/data/claude-accounts/account-1@1000000');
    expect(fetchUsage.mock.calls.map(([dir]) => dir)).toEqual(accounts.map((a) => a.configDir));
    expect(usage[0]).not.toHaveProperty('reason');
  });

  it('answers for one account, and for none when it does not exist', async () => {
    const { service, fetchUsage } = setup();

    expect((await service.usage({ accountId: 'account-1' })).map((e) => e.accountId)).toEqual([
      'account-1',
    ]);
    expect(await service.usage({ accountId: 'removed' })).toEqual([]);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it('reuses an answer for a minute unless forced', async () => {
    const { service, fetchUsage, advance } = setup();
    const first = await service.usage({ accountId: 'primary' });

    advance(USAGE_CACHE_MS - 1);
    expect(await service.usage({ accountId: 'primary' })).toEqual(first);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    await service.usage({ accountId: 'primary', force: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);

    advance(USAGE_CACHE_MS);
    await service.usage({ accountId: 'primary' });
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('shares one request between callers asking at the same moment', async () => {
    const { service, fetchUsage } = setup();

    await Promise.all([service.usage(), service.usage({ force: true })]);

    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('returns the earlier snapshot as stale when a later fetch fails', async () => {
    const { service, fetchUsage, advance } = setup();
    const [first] = await service.usage({ accountId: 'primary' });
    advance(USAGE_CACHE_MS);
    fetchUsage.mockResolvedValueOnce(err({ type: 'rate-limited' }));

    expect(await service.usage({ accountId: 'primary' })).toEqual([
      { accountId: 'primary', status: 'stale', snapshot: first?.snapshot, reason: 'rate-limited' },
    ]);
  });

  it('is unavailable without an earlier snapshot, and when the fetch throws', async () => {
    const { service, fetchUsage } = setup();
    fetchUsage
      .mockResolvedValueOnce(err({ type: 'token-expired' }))
      .mockRejectedValueOnce(new Error('boom'));

    expect(await service.usage()).toEqual([
      { accountId: 'primary', status: 'unavailable', snapshot: null, reason: 'token-expired' },
      { accountId: 'account-1', status: 'unavailable', snapshot: null, reason: 'network' },
    ]);
  });

  it('drops the earlier snapshot once the account is signed out', async () => {
    const { service, fetchUsage } = setup();
    await service.usage({ accountId: 'primary' });
    fetchUsage.mockResolvedValueOnce(err({ type: 'not-logged-in' }));

    expect(await service.usage({ accountId: 'primary', force: true })).toEqual([
      { accountId: 'primary', status: 'unavailable', snapshot: null, reason: 'not-logged-in' },
    ]);
  });

  it('forgets a removed account', async () => {
    const listed = [...accounts];
    const { service, fetchUsage } = setup(listed);
    await service.usage();
    listed.pop();
    await service.usage();
    listed.push(accounts[1]!);
    fetchUsage.mockResolvedValueOnce(err({ type: 'network', message: 'offline' }));

    const [entry] = await service.usage({ accountId: 'account-1' });

    expect(entry).toMatchObject({ status: 'unavailable', snapshot: null });
  });
});
