import type { ClaudeAccountMoveReason } from '@core/features/claude-accounts/api/types';

/** Moves a local Claude Code conversation to another Claude account. */
export type MoveClaudeAccountInput = {
  conversationId: string;
  /** The account to run on: `'primary'` or an extra account's id. */
  accountId: string;
  /**
   * Sent to the session once it runs on the new account, for example to pick interrupted work
   * back up. Without it nothing is sent. A conversation with no running session is started for
   * it; without it, such a conversation only has its account changed for its next start.
   */
  followUpPrompt?: string;
};

export type MoveClaudeAccountResult = {
  conversationId: string;
  fromAccountId: string;
  toAccountId: string;
  /** True when a session was started on the new account; false when none was running. */
  restarted: boolean;
  /** True when the follow-up prompt reached the session. */
  followUpSent: boolean;
};

export type MoveClaudeAccountError =
  | { type: 'conversation-not-found'; conversationId: string }
  /** Only Claude Code conversations have an account. */
  | { type: 'not-claude-conversation' }
  /** Accounts apply only to sessions on this computer outside WSL. */
  | { type: 'not-local'; message: string }
  /** The conversation cannot be moved: for example an automation run, or no task link. */
  | { type: 'unsupported'; message: string }
  /** The session cannot be reached to restart it right now (task not open, no workspace). */
  | { type: 'session-unavailable'; message: string }
  | { type: 'account-not-found'; accountId: string }
  | { type: 'account-signed-out'; accountId: string }
  /** The conversation already runs on that account. */
  | { type: 'same-account'; accountId: string }
  /** The new account could not be recorded. Nothing changed. */
  | { type: 'config-write-failed'; message: string }
  /**
   * The session did not come back on the new account (for example the resumed session could
   * not be found). `restored`: the conversation is recorded on its previous account again,
   * and was resumed there if it had been running.
   */
  | { type: 'restart-failed'; message: string; restored: boolean };

/** What a completed move reports, to the accounts event stream among others. */
export type ClaudeAccountMoved = {
  conversationId: string;
  projectId: string;
  taskId: string;
  fromAccountId: string;
  toAccountId: string;
  reason: ClaudeAccountMoveReason;
};

/** Longest follow-up prompt accepted. */
export const MAX_CLAUDE_MOVE_FOLLOW_UP_LENGTH = 4_000;
