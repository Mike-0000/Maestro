import { reaction } from 'mobx';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { spokenProviderLabel } from '@core/features/canvas/api/provider-names';
import {
  describeClaudeAccountMoveError,
  describeClaudeAccountsForChat,
  getConversationClaudeAccount,
  resolveClaudeAccountChoice,
} from '@core/features/claude-accounts/contributions/browser/conductor-accounts';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { developerSubmissionsSince } from '@core/features/terminals/api/browser/pty/developer-typing';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import {
  buildCompletionReport,
  terminalTailReport,
  type CompletionReport,
} from '@core/primitives/agents/api/completion-report';
import { log } from '@core/primitives/logging/browser/logger';
import { matchInstalledProvider } from '../../api/provider-match';
import {
  answerPermission,
  interruptAgent,
  readAgentOutput,
  readFinalChatReply,
  readFinishedTerminal,
  sendToAgent,
  sendToLiveSession,
  stopAgentSession,
} from '../agent-io';
import { deliverPromptWhenReady } from '../deferred-prompt';
import type { DeliveryHold } from '../delivery-lane';
import { entryForConversation, installedProviders } from '../roster';
import { addAgentChat, resolveProviderId, startAgentSession } from '../spawn';
import { showsPermissionPrompt, type AgentSnapshot } from './agent-event';
import { formatChatList } from './chat-list';
import type { ChatInfo, ReceivedPrompts, StartChatInput, TaskAgentPort } from './session';
import { restartChatAgent, stopChatAgent, type SessionControlDeps } from './session-control';

/** How long a stopped session may take to leave the host's session list. */
const STOP_WAIT_MS = 8_000;
const STOP_POLL_MS = 150;

/** "(no output yet)", "(no terminal session)", "(the chat transcript is not available)". */
const NO_OUTPUT_NOTE =
  /^\((?:no output yet|no terminal session|the chat transcript is not available)\)$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chat-agent turns read back for the prompts they started with. */
const PROMPT_TURNS_READ = 8;
/** Without a cursor, the prompts of this many latest turns: what the agent is working from. */
const PROMPT_TURNS_FIRST = 2;

/**
 * The user prompts of a chat (ACP) agent's turns after turn `cursor`. Its transcript cannot say
 * who wrote a prompt: the developer in the chat's own input, or Maestro passing words on.
 */
async function chatAgentPrompts(
  conversationId: string,
  cursor: number | null
): Promise<ReceivedPrompts> {
  const client = await getConversationsClient();
  const result = await client.acp.loadHistory({ conversationId, limit: PROMPT_TURNS_READ });
  if (!result.success || result.data.unavailable) {
    return {
      prompts: [],
      cursor,
      unreadable: 'the chat transcript is not available while its session is asleep',
    };
  }
  const turns = [...result.data.turns].sort((a, b) => a.seq - b.seq);
  const fresh =
    cursor === null ? turns.slice(-PROMPT_TURNS_FIRST) : turns.filter((turn) => turn.seq > cursor);
  const prompts = fresh
    .filter((turn) => turn.initiator === 'user')
    .flatMap((turn) => {
      const text = turn.items
        .flatMap((item) =>
          item.kind === 'message' && item.role === 'user' && typeof item.text === 'string'
            ? [item.text]
            : []
        )
        .join('\n')
        .trim();
      return text ? [{ text, by: 'relayed' as const }] : [];
    });
  return { prompts, cursor: turns.at(-1)?.seq ?? cursor };
}

function snapshotOf(entry: AgentTileEntry): AgentSnapshot {
  return {
    status: entry.status,
    report: entry.completionReport,
    notification: entry.notificationType,
    conductor: entry.conductor ?? null,
  };
}

function sameSnapshot(a: AgentSnapshot | null, b: AgentSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.status === b.status &&
    a.report === b.report &&
    a.notification === b.notification &&
    a.conductor === b.conductor
  );
}

function heldWhile(hold: DeliveryHold): string {
  if (hold.reason === 'unsent-text')
    return "until the text in the agent's input is sent or cleared";
  return hold.reason === 'prompt'
    ? "until the agent's prompt is answered"
    : "while the developer types in the agent's terminal";
}

/** The name a chat goes by: its window title, as the task view shows it. */
export function chatName(entry: AgentTileEntry): string {
  return formatConversationTitleForDisplay(entry.providerId, entry.conversationTitle);
}

/**
 * A new chat's tab in the task view, behind the tab the developer is on: it is there to switch
 * to, and what they are looking at stays in front.
 */
function addChatTab(projectId: string, taskId: string, conversationId: string): void {
  const layout = getTaskComposition(projectId, taskId)?.paneLayout;
  if (!layout) return;
  const pane = layout.focusedPane;
  const front = pane.activeTabId;
  layout.open('conversation', { conversationId }, { preview: false });
  if (front && pane.activeTabId !== front) pane.setActiveTab(front);
}

/**
 * A task's chats for its conductor, on the conductor's own agent IO: the same delivery lane,
 * session start and spawn path Maestro's conductor uses, so a prompt typed for the developer
 * behaves the same whoever sends it. Every action names its chat by conversation id.
 */
export function createTaskAgentPort(canvas: CanvasStore, taskId: string): TaskAgentPort {
  const entries = () => canvas.agentEntries.filter((entry) => entry.taskId === taskId);
  const find = (chatId: string) => {
    const entry = entryForConversation(canvas, chatId);
    return entry?.taskId === taskId ? entry : undefined;
  };
  const need = (chatId: string): AgentTileEntry => {
    const entry = find(chatId);
    if (!entry) throw new Error('This chat is not loaded, so its agent cannot be reached.');
    return entry;
  };

  /** The conversation's provider and recorded account, as the accounts slice reads them. */
  const conversationOf = (entry: AgentTileEntry) => ({
    providerId: entry.providerId,
    claudeAccountId: conversationRegistry.get(entry.taskId)?.conversations.get(entry.conversationId)
      ?.data.claudeAccountId,
  });
  const control = (entry: AgentTileEntry): SessionControlDeps => {
    const chatId = entry.conversationId;
    return {
      kind: entry.type,
      agentLabel: spokenProviderLabel(entry.providerId),
      running: () => find(chatId)?.sessionActive ?? false,
      stop: () => stopAgentSession(entry),
      stopped: async () => {
        // The session list follows the host by subscription, a moment behind the stop itself.
        const deadline = Date.now() + STOP_WAIT_MS;
        while (find(chatId)?.sessionActive) {
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
        }
        return true;
      },
      start: () => startAgentSession(entry.projectId, entry.taskId, chatId),
      deliver: async (prompt) => {
        if (entry.type !== 'acp') return deliverPromptWhenReady(canvas, chatId, prompt);
        await sendToAgent(find(chatId) ?? entry, prompt, true);
        return true;
      },
      currentAccount: () => getConversationClaudeAccount(conversationOf(entry)),
      resolveAccount: (reference) => resolveClaudeAccountChoice(reference),
      move: async (accountId, followUpPrompt) =>
        (await getConversationsClient()).moveClaudeAccount(
          { conversationId: chatId, accountId, ...(followUpPrompt ? { followUpPrompt } : {}) },
          { timeoutMs: 0 }
        ),
      describeMoveError: (error, target, previous) =>
        describeClaudeAccountMoveError(error, { target, previous }),
    };
  };

  return {
    chats(): ChatInfo[] {
      return entries().map((entry) => ({
        id: entry.conversationId,
        name: chatName(entry),
        providerId: entry.providerId,
        providerLabel: spokenProviderLabel(entry.providerId),
        status: entry.status,
        running: entry.type === 'acp' || entry.sessionActive,
      }));
    },

    snapshot(chatId) {
      const entry = find(chatId);
      return entry ? snapshotOf(entry) : null;
    },

    watch(onChange) {
      // The canvas entries follow the live conversation stores, and survive a task being reloaded.
      let previous = new Map(entries().map((entry) => [entry.conversationId, snapshotOf(entry)]));
      return reaction(
        () => new Map(entries().map((entry) => [entry.conversationId, snapshotOf(entry)])),
        (next) => {
          const before = previous;
          previous = next;
          for (const [chatId, snapshot] of next) {
            if (!sameSnapshot(before.get(chatId) ?? null, snapshot)) onChange(chatId, snapshot);
          }
          for (const chatId of before.keys()) if (!next.has(chatId)) onChange(chatId, null);
        }
      );
    },

    facts() {
      const [first] = entries();
      return {
        taskName: first?.taskName ?? 'unknown',
        projectName: first?.projectName ?? 'unknown',
      };
    },

    async readOutput(chatId, lines) {
      const output = await readAgentOutput(need(chatId), lines);
      // `readAgentOutput` answers with a parenthesized note when it has no output to give.
      return NO_OUTPUT_NOTE.test(output.trim()) ? '' : output;
    },

    async finishedReport(chatId): Promise<CompletionReport | null> {
      const entry = find(chatId);
      if (!entry) return null;
      if (entry.completionReport) return entry.completionReport;
      return entry.type === 'acp'
        ? buildCompletionReport(await readFinalChatReply(entry).catch(() => null))
        : terminalTailReport(await readFinishedTerminal(entry).catch(() => null));
    },

    async send(chatId, message, onLateFailure) {
      const entry = need(chatId);
      // A send held for the developer's typing can wait minutes: the turn does not wait with it.
      let onHold: (hold: DeliveryHold) => void = () => {};
      const heldNow = new Promise<DeliveryHold>((resolve) => (onHold = resolve));
      const options = { onHold: (hold: DeliveryHold) => onHold(hold) };
      // The session list can call a live agent stopped; its host knows, so ask it before starting.
      const sending =
        entry.type === 'acp' || entry.sessionActive
          ? sendToAgent(entry, message, true, options).then(() => true)
          : sendToLiveSession(entry, message, true, options);
      const first = await Promise.race([sending, heldNow]);
      if (typeof first === 'object') {
        void sending.then(
          (typed) => {
            if (!typed) onLateFailure('The agent did not get the prompt: it is not running.');
          },
          (error: unknown) =>
            onLateFailure(`The agent did not get the prompt: ${errorMessage(error)}`)
        );
        return `Held ${heldWhile(first)}; it is typed once that clears. The thread shows the developer if it cannot be delivered.`;
      }
      if (first) return 'Sent to the agent.';
      const started = await startAgentSession(entry.projectId, entry.taskId, chatId);
      if (!started) throw new Error('The agent was not running and could not be started.');
      const delivered = await deliverPromptWhenReady(canvas, chatId, message);
      if (!delivered) throw new Error('The agent was started, but it did not take the prompt.');
      return 'The agent was not running: it was started, then sent the prompt.';
    },

    async interrupt(chatId) {
      const entry = need(chatId);
      if (entry.type !== 'acp' && !entry.sessionActive) {
        return 'The agent is not running, so there is nothing to interrupt.';
      }
      await interruptAgent(entry);
      return 'Interrupted the agent.';
    },

    async answerPrompt(chatId, decision) {
      const entry = need(chatId);
      // Answering presses a key in the terminal: only when a permission prompt is what it shows.
      if (!showsPermissionPrompt(snapshotOf(entry))) {
        throw new Error('The agent is not showing a permission prompt, so nothing was pressed.');
      }
      await answerPermission(entry, decision);
      return decision === 'allow'
        ? 'Allowed the permission prompt.'
        : 'Denied the permission prompt.';
    },

    async startChat(input: StartChatInput, onLateFailure) {
      const [first] = entries();
      if (!first) throw new Error('This task has no chat loaded, so no chat can be added to it.');
      const installed = await installedProviders().catch(() => []);
      // Detection that found nothing failed; the reference is then resolved among all providers.
      const match = installed.length > 0 ? matchInstalledProvider(input.provider, installed) : null;
      if (installed.length > 0 && !match) {
        throw new Error(
          `Provider "${input.provider}" is not installed. Installed: ${installed.map((provider) => provider.id).join(', ')}.`
        );
      }
      const providerId = match?.id ?? (await resolveProviderId(input.provider));
      let claudeAccountId: string | undefined;
      if (input.claudeAccount) {
        const choice = resolveClaudeAccountChoice(input.claudeAccount);
        if (!choice.ok) throw new Error(choice.message);
        claudeAccountId = choice.account.id;
      }
      const result = await addAgentChat({
        projectId: first.projectId,
        taskId,
        providerId,
        prompt: input.prompt,
        ...(input.name ? { title: input.name } : {}),
        ...(claudeAccountId ? { claudeAccountId } : {}),
      });
      addChatTab(first.projectId, taskId, result.conversationId);
      const label = spokenProviderLabel(result.providerId);
      const failed = (why: string) => {
        log.warn('task conductor: started chat did not come up', {
          conversationId: result.conversationId,
        });
        onLateFailure(`The ${label} chat "${result.title}" ${why}`);
      };
      if (result.promptDeferred) {
        // Its provider takes no prompt at start: the brief is typed in once the agent is up.
        void startAgentSession(first.projectId, taskId, result.conversationId)
          .then(async (started) => {
            if (!started) return failed('did not start. Open its tab to see why.');
            const delivered = await deliverPromptWhenReady(
              canvas,
              result.conversationId,
              input.prompt
            );
            if (!delivered) failed('started, but did not take its prompt.');
          })
          .catch((error: unknown) => failed(`could not be started: ${errorMessage(error)}`));
      }
      return {
        chatId: result.conversationId,
        name: result.title,
        result: `Started the chat "${result.title}" in this task with a ${label} agent; it is starting with the prompt. Its events reach you like the other chats'. The thread shows the developer if it does not come up.`,
      };
    },

    restart(chatId, input, onLateFailure) {
      return restartChatAgent(control(need(chatId)), input, onLateFailure);
    },

    stop(chatId) {
      return stopChatAgent(control(need(chatId)));
    },

    listAccounts(chatId) {
      return describeClaudeAccountsForChat(conversationOf(need(chatId)), Date.now());
    },

    chatDeleted(chatId) {
      // The task's chats are still loaded but this one is gone from them: deleted or moved.
      const manager = conversationRegistry.get(taskId);
      return manager !== undefined && !manager.conversations.has(chatId);
    },

    async receivedPrompts(chatId, cursor) {
      const entry = need(chatId);
      if (entry.type === 'acp') return chatAgentPrompts(chatId, cursor);
      // A terminal agent: what the developer submitted with their own keys in this window. The
      // conductor's and Maestro's sends never go through the keys, so these are the developer's.
      const now = Date.now();
      const submitted = developerSubmissionsSince(chatId, cursor ?? 0).filter(
        (submission) => submission.at <= now
      );
      return {
        prompts: submitted.map((submission) => ({ text: submission.text, by: 'developer' })),
        cursor: now,
      };
    },

    listChats() {
      return formatChatList(
        entries().map((entry) => ({
          title: chatName(entry),
          provider: spokenProviderLabel(entry.providerId),
          status: entry.status,
          running: entry.type === 'acp' || entry.sessionActive,
          report: entry.completionReport?.text ?? null,
        }))
      );
    },
  };
}
