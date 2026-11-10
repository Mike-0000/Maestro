import { randomUUID } from 'node:crypto';
import {
  hostRefFromParts,
  LOCAL_HOST_REF,
  type SerializedHostRef,
} from '@emdash/core/primitives/host/api';
import type { TuiSessionState } from '@emdash/core/runtimes/tui-agents/api';
import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { and, eq } from 'drizzle-orm';
import type { ClaudeAccountLaunchResolver } from '@core/features/claude-accounts/api/node/launch';
import { PRIMARY_CLAUDE_ACCOUNT_ID } from '@core/features/claude-accounts/api/types';
import type { ClaudeAccountMoved } from '@core/features/conversations/api/claude-account-move';
import {
  conversationRegistryTable as conversations,
  createConversationRegistry,
} from '@core/features/conversations/api/node/registry';
import { mapConversationRowToConversation } from '@core/features/conversations/api/node/utils';
import type {
  ConversationsHostRuntimesClient,
  ConversationsRuntimeBroker,
} from '@core/features/conversations/api/runtime-adapter';
import type { ProjectAttachmentAccess } from '@core/features/projects/api/node/attached-project';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import { finalAssistantReply } from '@core/primitives/agents/api/completion-report';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import type { ConversationConfig } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import {
  createClaudeAccountMover,
  type ClaudeAccountMovePorts,
  type ClaudeAccountMover,
  type ClaudeMoveConversation,
  type ClaudeSessionRestartMode,
  type LinkedClaudeMoveConversation,
} from './claude-account-move';
import { conversationWireEvents } from './event-host';
import { resolveConversationHostClient } from './host-mutation';
import { setConversationAcpConfigOption } from './set-acp-config-option';
import type { ConversationRuntimeTarget } from './wire-controller';

/**
 * The terminal runtime replaces a resumed session that exits within 3 s with a fresh one
 * (`RESUME_FALLBACK_WINDOW_MS`); a resume only counts once it has outlived that window.
 */
export const RESUME_SETTLE_MS = 4_000;
/** Before typing into a resumed terminal session, its output must have been quiet this long. */
export const RESUME_QUIET_MS = 1_500;
/** Longest wait for a resumed terminal session to settle. */
export const RESUME_TIMEOUT_MS = 30_000;
const RESUME_POLL_MS = 250;
/** Between typing a prompt into a terminal agent and pressing Enter. */
const SUBMIT_DELAY_MS = 150;
/**
 * After stopping a terminal session outside Windows: the runtime ends its tmux session in the
 * background, and a resume that found it still there would attach to the old process.
 */
const TMUX_STOP_GRACE_MS = 1_000;

export type ClaudeAccountMoveRuntimeOptions = {
  db: AppDb;
  runtimes: ConversationsRuntimeBroker;
  hostIsReachable: (hostRef: SerializedHostRef) => boolean;
  projects: ProjectAttachmentAccess;
  taskSessions: Pick<TaskSessionManager, 'getTask'>;
  /** The fresh launch target of a conversation (ACP input with the recorded account's env). */
  resolveTarget(conversationId: string): Promise<ConversationRuntimeTarget>;
  claudeAccounts: Pick<ClaudeAccountLaunchResolver, 'prepare'> & ClaudeAccountMovePorts['accounts'];
  getProviderConfig(providerId: string): Promise<ProviderCustomConfig | undefined>;
  /** Install gate and work tracking around dispatching a prompt, as for user prompts. */
  recordWorkStarted?(projectId: string, taskId: string): Promise<() => void>;
  recordInputSubmitted?(projectId: string, taskId: string): Promise<() => void>;
  onMoved?(moved: ClaudeAccountMoved): void;
  logger: Pick<Logger, 'info' | 'warn'>;
  platform?: NodeJS.Platform;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};

/** The mover against the real conversation index, terminal runtime and chat runtime. */
export function createClaudeAccountMoveRuntime(
  options: ClaudeAccountMoveRuntimeOptions
): ClaudeAccountMover {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const pty = terminalSessions(options, sleep, now, platform);
  const acp = chatSessions(options);
  const pick = (conversation: LinkedClaudeMoveConversation) =>
    conversation.type === 'acp' ? acp : pty;

  return createClaudeAccountMover({
    load: (conversationId) => loadConversation(options, conversationId),
    accounts: options.claudeAccounts,
    writeAccount: (conversation, accountId) => writeAccount(options, conversation, accountId),
    session: {
      available: async (conversation) => {
        const attached = options.projects.requireAttached(conversation.projectId);
        if (!attached.success) return err('The project is not open');
        return pick(conversation).available(conversation);
      },
      isRunning: (conversation) => pick(conversation).isRunning(conversation),
      restart: (conversation, accountId, mode) =>
        pick(conversation).restart(conversation, accountId, mode),
      sendPrompt: (conversation, text) => pick(conversation).sendPrompt(conversation, text),
    },
    onMoved: options.onMoved,
    logger: options.logger,
  });
}

type SessionPort = {
  available(conversation: LinkedClaudeMoveConversation): Promise<Result<void, string>>;
  isRunning(conversation: LinkedClaudeMoveConversation): Promise<boolean>;
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

async function loadConversation(
  options: ClaudeAccountMoveRuntimeOptions,
  conversationId: string
): Promise<ClaudeMoveConversation | null> {
  const [row] = await options.db
    .select({
      projectId: conversations.projectId,
      taskId: conversations.taskId,
      provider: conversations.provider,
      type: conversations.type,
      config: conversations.config,
      sessionId: conversations.providerSessionId,
      location: conversations.location,
      sshConnectionId: conversations.sshConnectionId,
      taskType: tasks.type,
    })
    .from(conversations)
    .leftJoin(
      tasks,
      and(eq(tasks.id, conversations.taskId), eq(tasks.projectId, conversations.projectId))
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) return null;
  const type = row.type === 'acp' ? 'acp' : 'pty';
  const providerId = row.provider ?? '';
  // A terminal session asked to run inside WSL2 keeps the distro's own sign-in.
  const inWsl =
    type === 'pty' && providerId !== ''
      ? (await options.getProviderConfig(providerId))?.wsl === true
      : false;
  return {
    conversationId,
    projectId: row.projectId,
    taskId: row.taskId,
    providerId,
    type,
    host: hostRefFromParts(row.location, row.sshConnectionId),
    recordedAccountId: row.config?.claudeAccountId,
    sessionId: row.sessionId,
    automationRun: row.taskType === 'automation-run',
    inWsl,
  };
}

/**
 * Records the account through the host index, the sole writer of conversation config, then
 * mirrors the acknowledged config into the local registry and tells the renderer.
 */
async function writeAccount(
  options: ClaudeAccountMoveRuntimeOptions,
  conversation: LinkedClaudeMoveConversation,
  accountId: string | undefined
): Promise<Result<void, string>> {
  const { conversationId } = conversation;
  let resolved: Awaited<ReturnType<typeof resolveConversationHostClient>>;
  try {
    resolved = await resolveConversationHostClient(options, conversationId);
  } catch (error) {
    return err(errorMessage(error));
  }
  const current = resolved.row.config;
  if (!current) return err('The conversation has no stored configuration');
  const config: ConversationConfig = { ...current };
  if (accountId === undefined) delete config.claudeAccountId;
  else config.claudeAccountId = accountId;
  const updated = await resolved.client.updateConfig({ conversationId, config });
  if (!updated.success) return err(updated.error.message ?? updated.error.type);

  createConversationRegistry(options.db).refresh(conversationId, {
    config: updated.data.config as ConversationConfig,
    updatedAt: new Date(updated.data.updatedAt).toISOString(),
    lastObservedAt: new Date().toISOString(),
  });
  conversationWireEvents.emit(
    { taskId: conversation.taskId },
    {
      type: 'changed',
      conversationId,
      taskId: conversation.taskId,
      projectId: conversation.projectId,
      changes: { claudeAccountId: accountId },
    }
  );
  return ok();
}

async function runtimeClient(
  options: Pick<ClaudeAccountMoveRuntimeOptions, 'runtimes'>,
  conversation: ClaudeMoveConversation
): Promise<Result<ConversationsHostRuntimesClient, string>> {
  const client = await options.runtimes.client(conversation.host);
  return client.success ? ok(client.data) : err(client.error.message);
}

/**
 * Waits until a (re)started terminal session is up on its own: running past the window in
 * which the runtime would swap a resumed session for a fresh one, and quiet for a moment so
 * typed input is read as input. A swap for a fresh session means the saved session was not
 * found under the new account: that is a failure, not a success with lost history.
 */
export async function waitForTerminalSession(
  read: () => Promise<TuiSessionState | undefined>,
  resuming: boolean,
  clock: { now(): number; sleep(ms: number): Promise<void> }
): Promise<Result<void, string>> {
  const startedAt = clock.now();
  for (;;) {
    const state = await read();
    const elapsed = clock.now() - startedAt;
    if (resuming && state?.resume?.outcome === 'fresh-fallback') {
      return err('Claude Code could not find the saved session under the new account');
    }
    if (state?.status === 'exited') return err('The session exited right after starting');
    if (state?.status === 'running' && elapsed >= RESUME_SETTLE_MS) {
      const quietFor = clock.now() - (state.lastOutputAt ?? state.startedAt);
      if (quietFor >= RESUME_QUIET_MS) return ok();
    }
    if (elapsed >= RESUME_TIMEOUT_MS) {
      // Still drawing after the timeout, but running and not replaced: it did resume.
      return state?.status === 'running'
        ? ok()
        : err('The session did not start on the new account in time');
    }
    await clock.sleep(RESUME_POLL_MS);
  }
}

/** Terminal (PTY) sessions: stopped and resumed through the task's conversation provider. */
function terminalSessions(
  options: ClaudeAccountMoveRuntimeOptions,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  platform: NodeJS.Platform
): SessionPort {
  const sessionState = async (
    conversation: ClaudeMoveConversation
  ): Promise<TuiSessionState | undefined> => {
    const client = await runtimeClient(options, conversation);
    if (!client.success) return undefined;
    const snapshot = await client.data.tuiAgents.sessions.state(undefined, 'list').snapshot();
    return snapshot.data[conversation.conversationId];
  };

  const conversationFor = async (conversation: LinkedClaudeMoveConversation, accountId: string) => {
    const [row] = await options.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.conversationId))
      .limit(1);
    const mapped = row ? mapConversationRowToConversation(row) : null;
    if (!mapped) return null;
    // The session that was running, even if a fresh session reported another id meanwhile; and
    // the account to launch under, whatever the row says right now.
    return {
      ...mapped,
      sessionId: conversation.sessionId ?? undefined,
      claudeAccountId: accountId,
    };
  };

  return {
    async available(conversation) {
      return options.taskSessions.getTask(conversation.taskId)
        ? ok()
        : err('Open the task to restart its session');
    },
    async isRunning(conversation) {
      const state = await sessionState(conversation).catch(() => undefined);
      return state?.status === 'running' || state?.status === 'starting';
    },
    async restart(conversation, accountId, mode) {
      // Nothing runs, and the next start builds its launch from the recorded account.
      if (mode === 'refresh') return ok();
      const task = options.taskSessions.getTask(conversation.taskId);
      if (!task) return err('The task is not open');
      try {
        if (mode === 'restart' || mode === 'stop') {
          await task.conversations.stopSession(conversation.conversationId);
          if (platform !== 'win32') await sleep(TMUX_STOP_GRACE_MS);
        }
        if (mode === 'stop') return ok();
        const launch = await conversationFor(conversation, accountId);
        if (!launch) return err('The conversation no longer exists');
        const resuming = conversation.sessionId !== null;
        const started = await task.conversations.ensureSession({
          conversation: launch,
          mode: resuming ? 'resume' : 'start',
        });
        if (started.outcome === 'attached') {
          // Something else started it after the stop; it was launched from the recorded
          // account all the same, so it is checked like our own.
          options.logger.info('ClaudeAccounts: a moved session was started elsewhere', {
            conversationId: conversation.conversationId,
          });
        }
        return await waitForTerminalSession(
          () => sessionState(conversation).catch(() => undefined),
          resuming,
          { now, sleep }
        );
      } catch (error) {
        return err(errorMessage(error));
      }
    },
    async sendPrompt(conversation, text) {
      const client = await runtimeClient(options, conversation);
      if (!client.success) return client;
      const conversationId = conversation.conversationId;
      const typed = await client.data.tuiAgents.sendInput({
        conversationId,
        data: text.replace(/[\r\n]+/g, ' ').trim(),
      });
      if (!typed.success) return err(typed.error.type);
      await sleep(SUBMIT_DELAY_MS);
      const release = await options.recordInputSubmitted?.(
        conversation.projectId,
        conversation.taskId
      );
      try {
        const entered = await client.data.tuiAgents.sendInput({ conversationId, data: '\r' });
        return entered.success ? ok() : err(entered.error.type);
      } finally {
        release?.();
      }
    },
  };
}

/** Chat (ACP) sessions: ended and reloaded through the ACP runtime's public commands. */
function chatSessions(options: ClaudeAccountMoveRuntimeOptions): SessionPort {
  return {
    async available(conversation) {
      const target = await options.resolveTarget(conversation.conversationId).catch(() => null);
      return target?.acpInput ? ok() : err('The conversation has no workspace to run in yet');
    },
    async isRunning(conversation) {
      const client = await runtimeClient(options, conversation);
      if (!client.success) return false;
      const snapshot = await client.data.acp.sessions
        .state(undefined, 'list')
        .snapshot()
        .catch(() => null);
      const summary = snapshot?.data[conversation.conversationId];
      return Boolean(summary && !summary.suspended && summary.lifecycle !== 'closed');
    },
    async restart(conversation, accountId, mode) {
      const { conversationId } = conversation;
      let target: ConversationRuntimeTarget;
      try {
        target = await options.resolveTarget(conversationId);
      } catch (error) {
        return err(errorMessage(error));
      }
      const input = target.acpInput;
      // Without a workspace nothing is retained to refresh; the next attach resolves afresh.
      if (!input) return mode === 'refresh' ? ok() : err('The conversation has no workspace yet');
      // The launch is built from the recorded account; anything else is a bug worth stopping on.
      const launchAccount = target.claudeAccount?.accountId ?? PRIMARY_CLAUDE_ACCOUNT_ID;
      if (launchAccount !== accountId) {
        return err('The session would not start on the chosen account');
      }
      const client = await runtimeClient(options, conversation);
      if (!client.success) return client;
      try {
        if (target.claudeAccount) await options.claudeAccounts.prepare(target.claudeAccount);
      } catch (error) {
        return err(errorMessage(error));
      }
      if (mode === 'restart' || mode === 'stop') {
        // Ends the running agent process; the conversation stays resumable by its session id.
        const ended = await client.data.acp.terminate({ conversationId });
        if (!ended.success) return err(ended.error.message ?? ended.error.type);
      }
      // Stores the launch settings (with the account's environment) without starting anything.
      const attached = await client.data.acp.attach(input);
      if (!attached.success) return err(attached.error.message ?? attached.error.type);
      if (mode === 'refresh' || mode === 'stop') return ok();
      // Loading history brings the session up, restoring the saved session: never a new one.
      const loaded = await client.data.acp.loadHistory({ conversationId, limit: 1 });
      if (!loaded.success) return err(loaded.error.message ?? loaded.error.type);
      if (loaded.data.unavailable) return err('The resumed session has no history');
      for (const key of loaded.data.clearedConfiguration ?? []) {
        const cleared = await setConversationAcpConfigOption(options, conversationId, key, null);
        if (!cleared.success) {
          options.logger.warn('ClaudeAccounts: could not clear an unsupported setting', {
            conversationId,
            key,
          });
        }
      }
      return ok();
    },
    async sendPrompt(conversation, text) {
      const client = await runtimeClient(options, conversation);
      if (!client.success) return client;
      const release = await options.recordWorkStarted?.(
        conversation.projectId,
        conversation.taskId
      );
      try {
        const sent = await client.data.acp.sendPrompt(
          {
            conversationId: conversation.conversationId,
            promptId: randomUUID(),
            prompt: { text },
          },
          { timeoutMs: 0 }
        );
        return sent.success ? ok() : err(sent.error.message ?? sent.error.type);
      } finally {
        release?.();
      }
    },
  };
}

/**
 * Reads what a local session last showed, for recognising a usage limit: the end of a terminal
 * session's output, and the final reply of a live chat session's latest turn. Neither starts
 * nor wakes a session; both answer null when there is nothing to read.
 */
export function createClaudeConversationSignals(runtimes: ConversationsRuntimeBroker): {
  terminalTail(conversationId: string): Promise<string | null>;
  lastChatReply(conversationId: string): Promise<string | null>;
} {
  const local = async () => {
    const client = await runtimes.client(LOCAL_HOST_REF);
    return client.success ? client.data : null;
  };
  return {
    async terminalTail(conversationId) {
      const client = await local();
      if (!client) return null;
      // A snapshot of the retained log: reading it does not attach a viewer to the session.
      const snapshot = await client.tuiAgents.output.handle({ conversationId }).snapshot();
      return snapshot.data.text;
    },
    async lastChatReply(conversationId) {
      const client = await local();
      if (!client) return null;
      // Loading history would wake a suspended session; only a live one is read.
      const sessions = await client.acp.sessions.state(undefined, 'list').snapshot();
      const summary = sessions.data[conversationId];
      if (!summary || summary.suspended || summary.lifecycle === 'closed') return null;
      const page = await client.acp.loadHistory({ conversationId, limit: 1 }, { timeoutMs: 3_000 });
      if (!page.success || page.data.unavailable) return null;
      const turn = page.data.turns.at(-1);
      return turn ? finalAssistantReply(turn.items) : null;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
