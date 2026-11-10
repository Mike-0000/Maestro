import type { Result } from '@emdash/shared';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { getClaudeAccountsClient, type ClaudeAccountsRpcClient } from '../api/browser/client';
import {
  PRIMARY_CLAUDE_ACCOUNT_ID,
  type ClaudeAccount,
  type ClaudeAccountsError,
  type ClaudeAccountsState,
  type ClaudeAccountUsage,
} from '../api/types';
import { isAccountSignedIn } from './account-model';
import { LimitNoticeCoalescer, type LimitNotice, type LimitNoticeEvent } from './limit-notices';

/** How often usage is fetched again while something that shows it is on screen. */
export const USAGE_POLL_MS = 5 * 60_000;
/** Opening a usage surface fetches again only when the numbers are older than this. */
export const USAGE_REUSE_MS = 60_000;

export type ClaudeAccountsStoreDeps = {
  getClient: () => Promise<ClaudeAccountsRpcClient>;
  now: () => number;
  isWindowVisible: () => boolean;
  /** Calls the listener whenever the window is shown or hidden. Returns the unsubscribe. */
  onWindowVisibilityChange: (listener: () => void) => () => void;
  /** Shows a toast about a conversation that hit its usage limit; same `id` updates it. */
  notify: (notice: LimitNotice) => void;
  /** The title of the conversation an account event is about, or null when not known here. */
  conversationTitle: (event: LimitNoticeEvent) => string | null;
};

const browserDeps: ClaudeAccountsStoreDeps = {
  getClient: getClaudeAccountsClient,
  now: () => Date.now(),
  isWindowVisible: () => document.visibilityState === 'visible',
  onWindowVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  notify: () => undefined,
  conversationTitle: () => null,
};

/**
 * Claude accounts as the renderer sees them: the accounts and the default (kept current by the
 * `events` stream) and each account's usage. Usage is only polled while a surface that shows it
 * is mounted and the window is visible.
 */
export class ClaudeAccountsStore {
  state: ClaudeAccountsState | null = null;
  readonly usage = observable.map<string, ClaudeAccountUsage>({}, { deep: false });
  usageLoading = false;
  /** When usage last came back, successfully or not per account. */
  usageCheckedAt: number | null = null;

  private readonly deps: ClaudeAccountsStoreDeps;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private usageWatchers = 0;
  private usageRequest: Promise<void> | null = null;
  private readonly identityReconciled = new Set<string>();
  private disposed = false;
  private readonly limitNotices: LimitNoticeCoalescer;

  constructor(deps: Partial<ClaudeAccountsStoreDeps> = {}) {
    this.deps = { ...browserDeps, ...deps };
    this.limitNotices = new LimitNoticeCoalescer(() => this.deps.now());
    makeObservable(this, {
      state: observable.ref,
      usageLoading: observable,
      usageCheckedAt: observable,
      accounts: computed,
      defaultAccountId: computed,
      defaultAccount: computed,
      hasMultipleAccounts: computed,
      hasAnySignIn: computed,
      autoSwitchOnLimit: computed,
      applyState: action,
    });
  }

  get accounts(): ClaudeAccount[] {
    return this.state?.accounts ?? [];
  }

  get defaultAccountId(): string {
    return this.state?.defaultAccountId ?? PRIMARY_CLAUDE_ACCOUNT_ID;
  }

  get defaultAccount(): ClaudeAccount | undefined {
    return this.accounts.find((account) => account.id === this.defaultAccountId);
  }

  get hasMultipleAccounts(): boolean {
    return this.accounts.length > 1;
  }

  get hasAnySignIn(): boolean {
    return this.accounts.some((account) => this.isSignedIn(account));
  }

  /** Whether conversations that hit a usage limit move by themselves. Older payloads: on. */
  get autoSwitchOnLimit(): boolean {
    return this.state?.autoSwitchOnLimit ?? true;
  }

  account(accountId: string): ClaudeAccount | undefined {
    return this.accounts.find((account) => account.id === accountId);
  }

  isSignedIn(account: ClaudeAccount): boolean {
    return isAccountSignedIn(account, this.usage.get(account.id));
  }

  /** Loads the accounts, follows their changes, and fetches usage once. */
  start(): void {
    void this.connect();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.stopPolling();
  }

  applyState(state: ClaudeAccountsState): void {
    this.state = state;
    const known = new Set(state.accounts.map((account) => account.id));
    for (const accountId of Array.from(this.usage.keys())) {
      if (!known.has(accountId)) this.usage.delete(accountId);
    }
  }

  async reload(): Promise<void> {
    try {
      const client = await this.deps.getClient();
      const state = await client.list(undefined);
      if (!this.disposed) this.applyState(state);
    } catch {
      // Keep what is shown; the next event or reload brings it up to date.
    }
  }

  async create(label: string): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    const client = await this.deps.getClient();
    const result = await client.create({ label });
    if (result.success) this.patchAccount(result.data);
    return result;
  }

  async rename(
    accountId: string,
    label: string
  ): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    const client = await this.deps.getClient();
    const result = await client.rename({ accountId, label });
    if (result.success) this.patchAccount(result.data);
    return result;
  }

  async remove(accountId: string): Promise<Result<void, ClaudeAccountsError>> {
    const client = await this.deps.getClient();
    const result = await client.remove({ accountId });
    if (result.success && this.state) {
      // What the backend does: a removed default falls back to the primary account.
      this.applyState({
        ...this.state,
        accounts: this.state.accounts.filter((account) => account.id !== accountId),
        defaultAccountId:
          this.state.defaultAccountId === accountId
            ? PRIMARY_CLAUDE_ACCOUNT_ID
            : this.state.defaultAccountId,
      });
    }
    return result;
  }

  async setDefault(accountId: string): Promise<Result<void, ClaudeAccountsError>> {
    const client = await this.deps.getClient();
    const result = await client.setDefault({ accountId });
    if (result.success && this.state) {
      this.applyState({ ...this.state, defaultAccountId: accountId });
    }
    return result;
  }

  /**
   * Turns the automatic move at a usage limit on or off. Shows the new value at once and puts
   * the old one back when the change does not go through.
   */
  async setAutoSwitchOnLimit(enabled: boolean): Promise<boolean> {
    const previous = this.state;
    if (previous) this.applyState({ ...previous, autoSwitchOnLimit: enabled });
    try {
      const client = await this.deps.getClient();
      await client.setAutoSwitchOnLimit({ enabled });
      return true;
    } catch {
      // Only undo our own change: an event may have brought a newer state meanwhile.
      if (previous && this.state?.autoSwitchOnLimit === enabled) {
        this.applyState({ ...this.state, autoSwitchOnLimit: previous.autoSwitchOnLimit });
      }
      return false;
    }
  }

  /** Asks Claude Code who the account is signed in as. */
  async refreshIdentity(accountId: string): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    this.identityReconciled.add(accountId);
    const client = await this.deps.getClient();
    const result = await client.refreshIdentity({ accountId });
    if (result.success) this.patchAccount(result.data);
    return result;
  }

  /**
   * Fetches usage for every account. Callers asking at the same moment share one request; a
   * forced refresh (the refresh control) skips the backend's one-minute reuse.
   */
  refreshUsage(options: { force?: boolean } = {}): Promise<void> {
    if (this.usageRequest && !options.force) return this.usageRequest;
    const request = this.fetchUsage(options.force === true).finally(() => {
      if (this.usageRequest === request) this.usageRequest = null;
      runInAction(() => {
        this.usageLoading = this.usageRequest !== null;
      });
    });
    this.usageRequest = request;
    runInAction(() => {
      this.usageLoading = true;
    });
    return request;
  }

  /**
   * Fetches usage in the background when the figures held are older than a minute. For readers
   * that are not on screen (the conductor), so it works while the window is hidden.
   */
  refreshUsageIfStale(): void {
    const checkedAt = this.usageCheckedAt;
    if (checkedAt !== null && this.deps.now() - checkedAt < USAGE_REUSE_MS) return;
    void this.refreshUsage();
  }

  /**
   * Call while a surface showing usage is mounted. Polls every five minutes for as long as at
   * least one surface watches and the window is visible. Returns the stop function.
   */
  watchUsage(): () => void {
    this.usageWatchers++;
    if (this.usageWatchers === 1) this.startPolling();
    this.refreshUsageIfOlderThan(USAGE_REUSE_MS);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.usageWatchers--;
      if (this.usageWatchers === 0) this.stopPolling();
    };
  }

  private async connect(): Promise<void> {
    try {
      const client = await this.deps.getClient();
      const unsubscribe = await client.events.subscribe(undefined, {
        onEvent: (event) => {
          if (event.type !== 'changed') {
            this.handleLimitEvent(event);
            return;
          }
          this.applyState(event.state);
          // A new account has no usage entry yet.
          if (event.state.accounts.some((account) => !this.usage.has(account.id))) {
            void this.refreshUsage();
          }
        },
        onGap: () => void this.reload(),
      });
      if (this.disposed) {
        unsubscribe();
        return;
      }
      this.unsubscribeEvents = unsubscribe;
    } catch {
      // Without the stream, changes made here still apply through the action results.
    }
    await this.reload();
    await this.refreshUsage();
  }

  private handleLimitEvent(event: LimitNoticeEvent): void {
    // A move means a session now draws on another account; let the figures catch up.
    if (event.type === 'conversation-moved') void this.refreshUsage();
    const notice = this.limitNotices.add(event, {
      accountLabel: (accountId) => this.account(accountId)?.label ?? 'another account',
      conversationTitle: (target) => this.deps.conversationTitle(target),
    });
    if (notice) this.deps.notify(notice);
  }

  private async fetchUsage(force: boolean): Promise<void> {
    try {
      const client = await this.deps.getClient();
      const entries = await client.usage(force ? { force: true } : {});
      if (this.disposed) return;
      runInAction(() => {
        this.usage.replace(new Map(entries.map((entry) => [entry.accountId, entry])));
        this.usageCheckedAt = this.deps.now();
      });
      this.reconcileIdentities();
    } catch {
      // Keep the last numbers; the next poll or refresh tries again.
    }
  }

  /**
   * Usage can prove a sign-in the stored identity does not know about yet (it is only refreshed
   * on request), and the other way round. Ask Claude Code once per account and session.
   */
  private reconcileIdentities(): void {
    for (const account of this.accounts) {
      const usage = this.usage.get(account.id);
      if (!usage || this.identityReconciled.has(account.id)) continue;
      if (isAccountSignedIn(account, usage) === account.loggedIn) continue;
      void this.refreshIdentity(account.id).catch(() => undefined);
    }
  }

  private patchAccount(account: ClaudeAccount): void {
    if (!this.state) return;
    const exists = this.state.accounts.some((candidate) => candidate.id === account.id);
    this.applyState({
      ...this.state,
      accounts: exists
        ? this.state.accounts.map((candidate) =>
            candidate.id === account.id ? account : candidate
          )
        : [...this.state.accounts, account],
    });
  }

  private refreshUsageIfOlderThan(ageMs: number): void {
    if (!this.deps.isWindowVisible()) return;
    const checkedAt = this.usageCheckedAt;
    if (checkedAt !== null && this.deps.now() - checkedAt < ageMs) return;
    void this.refreshUsage();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.refreshUsageIfOlderThan(USAGE_REUSE_MS), USAGE_POLL_MS);
    // Coming back to the window after a long while should not show hours-old numbers.
    this.unsubscribeVisibility = this.deps.onWindowVisibilityChange(() =>
      this.refreshUsageIfOlderThan(USAGE_POLL_MS)
    );
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }
}
