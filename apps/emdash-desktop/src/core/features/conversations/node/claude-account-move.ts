import { isLocalHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import { err, ok, type Result } from '@emdash/shared';
import { KeyedMutex } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import { CLAUDE_ACCOUNTS_PROVIDER_ID } from '@core/features/claude-accounts/api/node/launch';
import {
  PRIMARY_CLAUDE_ACCOUNT_ID,
  type ClaudeAccountMoveReason,
  type ClaudeAccountsState,
} from '@core/features/claude-accounts/api/types';
import type {
  ClaudeAccountMoved,
  MoveClaudeAccountError,
  MoveClaudeAccountInput,
  MoveClaudeAccountResult,
} from '@core/features/conversations/api/claude-account-move';

/** What a move needs to know about the conversation, read once before anything changes. */
export type ClaudeMoveConversation = {
  conversationId: string;
  /** Null for an unlinked mirror row; such a conversation has no session surface. */
  projectId: string | null;
  taskId: string | null;
  providerId: string;
  type: 'pty' | 'acp';
  host: HostRef;
  /** The account recorded in the conversation's config; absent means the primary account. */
  recordedAccountId: string | undefined;
  /** The provider session the conversation resumes; null before its first session. */
  sessionId: string | null;
  /** Created by an automation run, whose runtime watches the session it started. */
  automationRun: boolean;
  /** A terminal session started inside WSL2, which keeps the distro's own sign-in. */
  inWsl: boolean;
};

/**
 * What the restart is asked to do:
 * - `restart`: a session is running: stop it, resume it on the recorded account, verify;
 * - `start`: none is running, but one is needed (to deliver a follow-up): resume and verify;
 * - `refresh`: none is running and none is needed: make sure the next start uses the recorded
 *   account (a chat session's retained launch settings are refreshed; nothing is spawned);
 * - `stop`: undo a `start` that failed: stop whatever came up, then `refresh`.
 */
export type ClaudeSessionRestartMode = 'restart' | 'start' | 'refresh' | 'stop';

/** A conversation with its task link, which every session operation needs. */
export type LinkedClaudeMoveConversation = ClaudeMoveConversation & {
  projectId: string;
  taskId: string;
};

export type ClaudeAccountMovePorts = {
  load(conversationId: string): Promise<ClaudeMoveConversation | null>;
  accounts: {
    list(): Promise<ClaudeAccountsState>;
    /** The account a recorded id stands for: itself, or the default when it was removed. */
    resolveAccountId(explicit?: string): Promise<string>;
    /**
     * Whether the usage service has a fresh answer for the account, which proves a working
     * sign-in even when the stored `loggedIn` flag (refreshed only on request) says otherwise.
     */
    hasFreshUsage?(accountId: string): Promise<boolean>;
  };
  /**
   * Records the account in the conversation's config through the host index (the sole writer).
   * `undefined` removes the field, restoring a conversation that never had one.
   */
  writeAccount(
    conversation: LinkedClaudeMoveConversation,
    accountId: string | undefined
  ): Promise<Result<void, string>>;
  session: {
    /** Whether the session can be restarted at all right now; checked before anything changes. */
    available(conversation: LinkedClaudeMoveConversation): Promise<Result<void, string>>;
    isRunning(conversation: LinkedClaudeMoveConversation): Promise<boolean>;
    /**
     * Brings the session up on `accountId`, which must already be recorded. Resolves once the
     * session is confirmed running on it (not a fresh session in place of the resumed one).
     */
    restart(
      conversation: LinkedClaudeMoveConversation,
      accountId: string,
      mode: ClaudeSessionRestartMode
    ): Promise<Result<void, string>>;
    sendPrompt(
      conversation: LinkedClaudeMoveConversation,
      text: string
    ): Promise<Result<void, string>>;
  };
  onMoved?(moved: ClaudeAccountMoved): void;
  logger: Pick<Logger, 'info' | 'warn'>;
};

export type ClaudeAccountMoveRequest = MoveClaudeAccountInput & {
  reason: ClaudeAccountMoveReason;
};

/** A local Claude conversation the automatic switch may move, and the account it runs on. */
export type MovableClaudeConversation = {
  conversationId: string;
  projectId: string;
  taskId: string;
  type: 'pty' | 'acp';
  accountId: string;
};

/**
 * Moves Claude conversations between accounts. One move per conversation at a time; a move
 * that cannot bring the session back on the new account puts the previous account back, so a
 * conversation never stays recorded on an account it is not running on.
 */
export class ClaudeAccountMover {
  private readonly locks = new KeyedMutex();

  constructor(private readonly ports: ClaudeAccountMovePorts) {}

  move(
    request: ClaudeAccountMoveRequest
  ): Promise<Result<MoveClaudeAccountResult, MoveClaudeAccountError>> {
    return this.locks.runExclusive(request.conversationId, () => this.moveExclusive(request));
  }

  /**
   * The account a local Claude conversation runs on, or null when it is not one the switch can
   * move (another provider, another host, WSL2, an automation run, no task link).
   */
  async describe(conversationId: string): Promise<MovableClaudeConversation | null> {
    const conversation = await this.ports.load(conversationId);
    if (!conversation || movability(conversation) !== null) return null;
    const linked = conversation as LinkedClaudeMoveConversation;
    return {
      conversationId,
      projectId: linked.projectId,
      taskId: linked.taskId,
      type: linked.type,
      accountId: await this.currentAccountId(linked),
    };
  }

  private async moveExclusive(
    request: ClaudeAccountMoveRequest
  ): Promise<Result<MoveClaudeAccountResult, MoveClaudeAccountError>> {
    const { conversationId } = request;
    const conversation = await this.ports.load(conversationId);
    if (!conversation) return err({ type: 'conversation-not-found', conversationId });
    const refused = movability(conversation);
    if (refused) return err(refused);
    const linked = conversation as LinkedClaudeMoveConversation;

    const state = await this.ports.accounts.list();
    const target = state.accounts.find((account) => account.id === request.accountId);
    if (!target) return err({ type: 'account-not-found', accountId: request.accountId });
    if (!(await this.signedIn(target))) {
      return err({ type: 'account-signed-out', accountId: target.id });
    }
    const fromAccountId = await this.currentAccountId(linked);
    if (fromAccountId === target.id) return err({ type: 'same-account', accountId: target.id });

    const wasRunning = await this.ports.session.isRunning(linked);
    const followUp = request.followUpPrompt?.trim();
    // A conversation that never had a session has nothing to resume; its first start, with its
    // own initial prompt, will run on the new account.
    const mode: ClaudeSessionRestartMode = wasRunning
      ? 'restart'
      : followUp && linked.sessionId !== null
        ? 'start'
        : 'refresh';
    if (mode !== 'refresh') {
      // Checked before anything changes: a session that cannot be brought back is not stopped.
      const available = await this.ports.session.available(linked);
      if (!available.success) {
        return err({ type: 'session-unavailable', message: available.error });
      }
    }

    const written = await this.ports.writeAccount(linked, target.id);
    if (!written.success) return err({ type: 'config-write-failed', message: written.error });

    const restarted = await this.ports.session.restart(linked, target.id, mode);
    if (!restarted.success) {
      const restoreMode = wasRunning ? 'restart' : mode === 'start' ? 'stop' : 'refresh';
      return err(await this.restore(linked, fromAccountId, restoreMode, restarted.error));
    }

    let followUpSent = false;
    if (followUp && mode !== 'refresh') {
      const sent = await this.ports.session.sendPrompt(linked, followUp);
      followUpSent = sent.success;
      if (!sent.success) {
        this.ports.logger.warn(
          'ClaudeAccounts: the follow-up after a move did not reach the agent',
          {
            conversationId,
            error: sent.error,
          }
        );
      }
    }

    this.ports.logger.info('ClaudeAccounts: conversation moved to another account', {
      conversationId,
      fromAccountId,
      toAccountId: target.id,
      reason: request.reason,
      restarted: mode !== 'refresh',
    });
    this.ports.onMoved?.({
      conversationId,
      projectId: linked.projectId,
      taskId: linked.taskId,
      fromAccountId,
      toAccountId: target.id,
      reason: request.reason,
    });
    return ok({
      conversationId,
      fromAccountId,
      toAccountId: target.id,
      restarted: mode !== 'refresh',
      followUpSent,
    });
  }

  /**
   * Puts the previous account back after a failed restart, and the session back on it when one
   * was running (`mode`). The recorded id is restored exactly, including its absence.
   */
  private async restore(
    conversation: LinkedClaudeMoveConversation,
    previousAccountId: string,
    mode: ClaudeSessionRestartMode,
    failure: string
  ): Promise<MoveClaudeAccountError> {
    const { conversationId } = conversation;
    this.ports.logger.warn('ClaudeAccounts: the session did not come back on the new account', {
      conversationId,
      error: failure,
    });
    const rewritten = await this.ports.writeAccount(conversation, conversation.recordedAccountId);
    if (!rewritten.success) {
      this.ports.logger.warn('ClaudeAccounts: could not put the previous account back', {
        conversationId,
        error: rewritten.error,
      });
      return { type: 'restart-failed', message: failure, restored: false };
    }
    const back = await this.ports.session.restart(conversation, previousAccountId, mode);
    if (!back.success) {
      this.ports.logger.warn('ClaudeAccounts: could not resume on the previous account', {
        conversationId,
        error: back.error,
      });
      return {
        type: 'restart-failed',
        message: `${failure}; resuming on the previous account also failed: ${back.error}`,
        restored: true,
      };
    }
    return { type: 'restart-failed', message: failure, restored: true };
  }

  /** Signed in: the stored flag says so, or the account's usage was just fetched with it. */
  private async signedIn(account: { id: string; loggedIn: boolean }): Promise<boolean> {
    if (account.loggedIn) return true;
    return (await this.ports.accounts.hasFreshUsage?.(account.id).catch(() => false)) ?? false;
  }

  private async currentAccountId(conversation: ClaudeMoveConversation): Promise<string> {
    // No recorded account: created on the primary sign-in, and it stays there (see `resolve`).
    if (conversation.recordedAccountId === undefined) return PRIMARY_CLAUDE_ACCOUNT_ID;
    return this.ports.accounts.resolveAccountId(conversation.recordedAccountId);
  }
}

function movability(conversation: ClaudeMoveConversation): MoveClaudeAccountError | null {
  if (conversation.providerId !== CLAUDE_ACCOUNTS_PROVIDER_ID) {
    return { type: 'not-claude-conversation' };
  }
  if (conversation.projectId === null || conversation.taskId === null) {
    return { type: 'unsupported', message: 'The conversation is not linked to a task' };
  }
  if (!isLocalHostRef(conversation.host)) {
    return {
      type: 'not-local',
      message: 'Claude accounts apply only to sessions on this computer',
    };
  }
  if (conversation.inWsl) {
    return { type: 'not-local', message: 'A session inside WSL2 uses the distro’s own sign-in' };
  }
  if (conversation.automationRun) {
    // The automation runtime waits on the session it started to deliver its result; stopping
    // it from here would look to that wait like the agent finished.
    return {
      type: 'unsupported',
      message: 'Conversations started by an automation cannot change account',
    };
  }
  return null;
}

export function createClaudeAccountMover(ports: ClaudeAccountMovePorts): ClaudeAccountMover {
  return new ClaudeAccountMover(ports);
}
