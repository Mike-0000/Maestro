import { readFile } from 'node:fs/promises';
import type { Result } from '@emdash/shared';
import type { ClaudeAccountUsage, ClaudeUsageSnapshot } from '../api/types';
import { fetchClaudeUsage, type ClaudeUsageError } from './usage-client';

/** How long an answer is reused before the usage endpoint is asked again. */
export const USAGE_CACHE_MS = 60_000;

export type ClaudeUsageServiceDeps = {
  /** Every account with the configuration directory its sign-in lives in, primary first. */
  listAccounts(): Promise<Array<{ id: string; configDir: string }>>;
  fetchUsage(configDir: string): Promise<Result<ClaudeUsageSnapshot, ClaudeUsageError>>;
  now(): number;
};

type CachedUsage = { snapshot: ClaudeUsageSnapshot; fetchedAtMs: number };

/**
 * Subscription usage per Claude account. Snapshots live in memory only: an answer is reused
 * for a minute, and the last good one is kept so a failed fetch can still show something.
 */
export class ClaudeUsageService {
  private readonly lastGood = new Map<string, CachedUsage>();
  private readonly inFlight = new Map<string, Promise<ClaudeAccountUsage>>();

  constructor(private readonly deps: ClaudeUsageServiceDeps) {}

  async usage(input: { accountId?: string; force?: boolean } = {}): Promise<ClaudeAccountUsage[]> {
    const accounts = await this.deps.listAccounts();
    const known = new Set(accounts.map((account) => account.id));
    // A removed account's snapshot must not come back if its id is ever seen again.
    for (const id of this.lastGood.keys()) if (!known.has(id)) this.lastGood.delete(id);

    const wanted = input.accountId
      ? accounts.filter((account) => account.id === input.accountId)
      : accounts;
    return Promise.all(wanted.map((account) => this.usageFor(account, input.force === true)));
  }

  private usageFor(
    account: { id: string; configDir: string },
    force: boolean
  ): Promise<ClaudeAccountUsage> {
    const cached = this.lastGood.get(account.id);
    if (!force && cached && this.deps.now() - cached.fetchedAtMs < USAGE_CACHE_MS) {
      return Promise.resolve({ accountId: account.id, status: 'fresh', snapshot: cached.snapshot });
    }
    // Callers asking at the same moment share one request.
    const running = this.inFlight.get(account.id);
    if (running) return running;
    const request = this.fetch(account).finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, request);
    return request;
  }

  private async fetch(account: { id: string; configDir: string }): Promise<ClaudeAccountUsage> {
    let reason: ClaudeAccountUsage['reason'];
    try {
      const result = await this.deps.fetchUsage(account.configDir);
      if (result.success) {
        this.lastGood.set(account.id, { snapshot: result.data, fetchedAtMs: this.deps.now() });
        return { accountId: account.id, status: 'fresh', snapshot: result.data };
      }
      reason = result.error.type;
    } catch {
      reason = 'network';
    }
    // Signed out means the earlier numbers belong to a sign-in that is gone.
    if (reason === 'not-logged-in') this.lastGood.delete(account.id);
    const earlier = this.lastGood.get(account.id);
    return earlier
      ? { accountId: account.id, status: 'stale', snapshot: earlier.snapshot, reason }
      : { accountId: account.id, status: 'unavailable', snapshot: null, reason };
  }
}

/** The service against the real sign-in files and the real usage endpoint. */
export function createClaudeUsageService(
  listAccounts: ClaudeUsageServiceDeps['listAccounts']
): ClaudeUsageService {
  const now = () => Date.now();
  return new ClaudeUsageService({
    listAccounts,
    fetchUsage: (configDir) =>
      fetchClaudeUsage(configDir, { readFile: (file) => readFile(file, 'utf8'), fetch, now }),
    now,
  });
}
