import {
  gitContract,
  type FetchError,
  type RepositorySelector,
} from '@emdash/core/runtimes/git/api';
import { err, ok, type Result } from '@emdash/shared';
import { gitErrorMessage, runGitJob } from '@main/core/git/runtime-client';
import type { GitRuntimeClient } from '@main/gateway/desktop-workers';
import { log } from '@main/lib/logger';

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
/** The longest a repository whose fetches keep failing waits before it is tried again. */
const MAX_BACKOFF_MS = 30 * 60 * 1000;

type GitRepositoryFetchResult = Result<void, FetchError>;

export class GitRepositoryFetchService {
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _inflight: Promise<GitRepositoryFetchResult> | undefined;
  private readonly intervalMs = DEFAULT_INTERVAL_MS;
  private _failures = 0;
  /** Polls still to pass up before a fetch that failed is tried again. */
  private _skipTicks = 0;

  constructor(
    private readonly git: GitRuntimeClient,
    private readonly repository: RepositorySelector,
    /** Resolver-backed effective base remote; `null` means no remotes exist. */
    private readonly getRemote: () => Promise<string | null>
  ) {}

  /** Start the background fetch loop: immediate fetch, then every `intervalMs`. */
  start(): void {
    void this._tick();
    this._scheduleNext();
  }

  stop(): void {
    clearInterval(this._timer);
    this._timer = undefined;
  }

  private _doFetch(): Promise<GitRepositoryFetchResult> {
    if (this._inflight) return this._inflight;
    this._inflight = this.getRemote()
      .then(async (remote) => {
        // No remotes resolved — nothing to fetch (never a literal fallback).
        if (remote === null) return ok(undefined);
        return runGitJob(gitContract.repository.fetch, this.git.repository.fetch, {
          ...this.repository,
          remote,
        });
      })
      .catch((e): GitRepositoryFetchResult => {
        const message = gitErrorMessage(e);
        log.warn('GitRepositoryFetchService: fetch threw unexpectedly', { error: message });
        return err({ type: 'git_error', message });
      })
      .finally(() => {
        this._inflight = undefined;
      });
    return this._inflight;
  }

  private _scheduleNext(): void {
    this._timer = setInterval(() => void this._tick(), this.intervalMs);
  }

  /**
   * One poll. A fetch that fails is not repeated every interval: each failure in a row doubles
   * the wait, up to `MAX_BACKOFF_MS`, so a broken repository or remote is not hit forever at the
   * full rate. The first success returns to the normal interval.
   */
  private async _tick(): Promise<void> {
    // A fetch still running from an earlier poll is not counted twice.
    if (this._inflight) return;
    if (this._skipTicks > 0) {
      this._skipTicks -= 1;
      return;
    }
    if (!(await this._canBackgroundFetchWithoutPrompt())) return;
    const result = await this._doFetch();
    if (result.success) {
      this._failures = 0;
      return;
    }
    this._failures += 1;
    const backoff = Math.min(this.intervalMs * 2 ** (this._failures - 1), MAX_BACKOFF_MS);
    this._skipTicks = Math.round(backoff / this.intervalMs) - 1;
    log.warn('GitRepositoryFetchService: background fetch failed; backing off', {
      failures: this._failures,
      retryInMs: backoff,
      error: gitErrorMessage(result.error),
    });
  }

  private async _canBackgroundFetchWithoutPrompt(): Promise<boolean> {
    try {
      await this.git.repository.model.state(this.repository, 'remotes').snapshot();
    } catch {
      return false;
    }

    return true;
  }
}
