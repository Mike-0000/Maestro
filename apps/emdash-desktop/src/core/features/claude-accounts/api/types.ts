/** The built-in account: the sign-in in `~/.claude`. Never stored, never removable. */
export const PRIMARY_CLAUDE_ACCOUNT_ID = 'primary';

export type ClaudeAccountKind = 'primary' | 'extra';

export type ClaudeAccount = {
  id: string;
  label: string;
  kind: ClaudeAccountKind;
  /** The account's own Claude Code configuration directory. Absent for the primary account. */
  configDir?: string;
  /** From the last identity refresh; absent until one has run or while signed out. */
  email?: string;
  /** Subscription type as Claude Code reports it (for example `max`), from the last refresh. */
  plan?: string;
  /** From the last identity refresh; false until one has found a sign-in. */
  loggedIn: boolean;
  /** ISO timestamp. Absent for the primary account. */
  createdAt?: string;
};

export type ClaudeAccountsState = {
  /** The primary account first, then extra accounts in creation order. */
  accounts: ClaudeAccount[];
  /** The account new Claude conversations use unless one is chosen explicitly. */
  defaultAccountId: string;
  /**
   * Whether a conversation that stops on a usage limit moves to another signed-in account by
   * itself. Always sent by the main process (default on); optional only for older payloads.
   */
  autoSwitchOnLimit?: boolean;
};

export type ClaudeAccountsError =
  | { type: 'not-found'; accountId: string }
  /** The primary account cannot be renamed or removed. */
  | { type: 'primary-immutable' }
  | { type: 'invalid-label'; message: string }
  /** The Claude Code CLI could not be found or did not answer. */
  | { type: 'cli-unavailable'; message: string }
  /** The account's folder could not be created, prepared or removed. */
  | { type: 'folder-failed'; message: string };

/** One usage window of a subscription: how much is used and when it resets. */
export type ClaudeUsageWindow = { usedPercent: number; resetsAt: string | null };

export type ClaudeUsageLimit = {
  kind: string;
  group: string | null;
  scope: string | null;
  usedPercent: number;
  resetsAt: string | null;
  severity: string | null;
};

export type ClaudeUsageSnapshot = {
  /** ISO timestamp of the fetch that produced this snapshot. */
  fetchedAt: string;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  sevenDayOpus: ClaudeUsageWindow | null;
  sevenDaySonnet: ClaudeUsageWindow | null;
  limits: ClaudeUsageLimit[];
};

/** Why an account's usage could not be fetched. */
export type ClaudeUsageErrorType =
  | 'not-logged-in'
  | 'token-expired'
  | 'unauthorized'
  | 'rate-limited'
  | 'network'
  | 'unexpected-response';

export type ClaudeAccountUsage = {
  accountId: string;
  /**
   * `fresh`: fetched now or within the cache window. `stale`: the fetch failed but an earlier
   * snapshot exists, returned with its original `fetchedAt`. `unavailable`: no snapshot at all.
   */
  status: 'fresh' | 'stale' | 'unavailable';
  snapshot: ClaudeUsageSnapshot | null;
  /** Why the latest fetch failed. Absent when `fresh`. */
  reason?: ClaudeUsageErrorType;
};

/** Why a conversation changed account: the user asked, or its account hit a usage limit. */
export type ClaudeAccountMoveReason = 'manual' | 'limit';

/**
 * Why a conversation that hit a usage limit stayed where it was:
 * - `no-eligible-account`: no other signed-in account has known usage below 90% on both windows;
 * - `burst-cap`: the eligible accounts already took the most conversations allowed in a short
 *   time (`AUTO_SWITCH_BURST_LIMIT` per `AUTO_SWITCH_BURST_WINDOW_MS`);
 * - `cooldown`: the conversation was already moved automatically within the last 15 minutes;
 * - `move-failed`: the move was tried and failed; `message` says why.
 */
export type ClaudeLimitUnhandledReason =
  | 'no-eligible-account'
  | 'burst-cap'
  | 'cooldown'
  | 'move-failed';

export type ClaudeAccountsEvent =
  | { type: 'changed'; state: ClaudeAccountsState }
  /** A conversation now runs on another account (its session was restarted there if running). */
  | {
      type: 'conversation-moved';
      conversationId: string;
      projectId: string;
      taskId: string;
      fromAccountId: string;
      toAccountId: string;
      reason: ClaudeAccountMoveReason;
    }
  /** A conversation stopped on a usage limit and was not moved. */
  | {
      type: 'limit-unhandled';
      conversationId: string;
      projectId: string;
      taskId: string;
      /** The account that hit its limit. */
      accountId: string;
      reason: ClaudeLimitUnhandledReason;
      message?: string;
    };

/** Most conversations moved onto one account by the automatic switch within the burst window. */
export const AUTO_SWITCH_BURST_LIMIT = 3;
export const AUTO_SWITCH_BURST_WINDOW_MS = 10 * 60_000;

export const MAX_CLAUDE_ACCOUNT_LABEL_LENGTH = 60;
