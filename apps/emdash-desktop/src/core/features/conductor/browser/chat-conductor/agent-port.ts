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
import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
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
import { entryForConversation, installedProviders, spawnPeers } from '../roster';
import { resolveProviderId, spawnAgentTask, startAgentSession } from '../spawn';
import { showsPermissionPrompt, type AgentSnapshot } from './agent-event';
import { formatChatList } from './chat-list';
import type { ChatAgentPort, StartAgentInput } from './session';
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

function snapshotOf(entry: AgentTileEntry): AgentSnapshot {
  return {
    status: entry.status,
    report: entry.completionReport,
    notification: entry.notificationType,
  };
}

function sameSnapshot(a: AgentSnapshot | null, b: AgentSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && a.report === b.report && a.notification === b.notification;
}

function heldWhile(hold: DeliveryHold): string {
  if (hold.reason === 'unsent-text')
    return "until the text in the agent's input is sent or cleared";
  return hold.reason === 'prompt'
    ? "until the agent's prompt is answered"
    : "while the developer types in the agent's terminal";
}

/**
 * A chat's agent for its conductor, on the conductor's own agent IO: the same delivery lane,
 * session start and spawn path Maestro's conductor uses, so a prompt typed for the developer
 * behaves the same whoever sends it.
 */
export function createChatAgentPort(canvas: CanvasStore, conversationId: string): ChatAgentPort {
  const find = () => entryForConversation(canvas, conversationId);
  const need = (): AgentTileEntry => {
    const entry = find();
    if (!entry) throw new Error('This chat is not loaded, so its agent cannot be reached.');
    return entry;
  };

  /** The conversation's provider and recorded account, as the accounts slice reads them. */
  const conversationOf = (entry: AgentTileEntry) => ({
    providerId: entry.providerId,
    claudeAccountId: conversationRegistry.get(entry.taskId)?.conversations.get(conversationId)?.data
      .claudeAccountId,
  });
  const control = (entry: AgentTileEntry): SessionControlDeps => ({
    kind: entry.type,
    agentLabel: spokenProviderLabel(entry.providerId),
    running: () => find()?.sessionActive ?? false,
    stop: () => stopAgentSession(entry),
    stopped: async () => {
      // The session list follows the host by subscription, a moment behind the stop itself.
      const deadline = Date.now() + STOP_WAIT_MS;
      while (find()?.sessionActive) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
      }
      return true;
    },
    start: () => startAgentSession(entry.projectId, entry.taskId, conversationId),
    deliver: async (prompt) => {
      if (entry.type !== 'acp') return deliverPromptWhenReady(canvas, conversationId, prompt);
      await sendToAgent(find() ?? entry, prompt, true);
      return true;
    },
    currentAccount: () => getConversationClaudeAccount(conversationOf(entry)),
    resolveAccount: (reference) => resolveClaudeAccountChoice(reference),
    move: async (accountId, followUpPrompt) =>
      (await getConversationsClient()).moveClaudeAccount(
        { conversationId, accountId, ...(followUpPrompt ? { followUpPrompt } : {}) },
        { timeoutMs: 0 }
      ),
    describeMoveError: (error, target, previous) =>
      describeClaudeAccountMoveError(error, { target, previous }),
  });

  return {
    snapshot() {
      const entry = find();
      return entry ? snapshotOf(entry) : null;
    },

    watch(onChange) {
      // The canvas entries follow the live conversation stores, and survive a task being reloaded.
      return reaction(
        () => {
          const entry = find();
          return entry ? snapshotOf(entry) : null;
        },
        (snapshot) => onChange(snapshot),
        { equals: sameSnapshot }
      );
    },

    facts() {
      const entry = find();
      if (!entry) {
        return {
          chatTitle: 'unknown',
          taskName: 'unknown',
          projectName: 'unknown',
          providerLabel: 'unknown agent',
          agentStatus: 'not loaded',
        };
      }
      const running = entry.type === 'acp' || entry.sessionActive;
      return {
        chatTitle: formatConversationTitleForDisplay(entry.providerId, entry.conversationTitle),
        taskName: entry.taskName,
        projectName: entry.projectName,
        providerLabel: spokenProviderLabel(entry.providerId),
        agentStatus: running ? entry.status : `${entry.status}, not running`,
      };
    },

    async readOutput(lines) {
      const output = await readAgentOutput(need(), lines);
      // `readAgentOutput` answers with a parenthesized note when it has no output to give.
      return NO_OUTPUT_NOTE.test(output.trim()) ? '' : output;
    },

    async finishedReport(): Promise<CompletionReport | null> {
      const entry = find();
      if (!entry) return null;
      if (entry.completionReport) return entry.completionReport;
      return entry.type === 'acp'
        ? buildCompletionReport(await readFinalChatReply(entry).catch(() => null))
        : terminalTailReport(await readFinishedTerminal(entry).catch(() => null));
    },

    async send(message, onLateFailure) {
      const entry = need();
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
      const started = await startAgentSession(entry.projectId, entry.taskId, entry.conversationId);
      if (!started) throw new Error('The agent was not running and could not be started.');
      const delivered = await deliverPromptWhenReady(canvas, conversationId, message);
      if (!delivered) throw new Error('The agent was started, but it did not take the prompt.');
      return 'The agent was not running: it was started, then sent the prompt.';
    },

    async interrupt() {
      const entry = need();
      if (entry.type !== 'acp' && !entry.sessionActive) {
        return 'The agent is not running, so there is nothing to interrupt.';
      }
      await interruptAgent(entry);
      return 'Interrupted the agent.';
    },

    async answerPrompt(decision) {
      const entry = need();
      // Answering presses a key in the terminal: only when a permission prompt is what it shows.
      if (!showsPermissionPrompt(snapshotOf(entry))) {
        throw new Error('The agent is not showing a permission prompt, so nothing was pressed.');
      }
      await answerPermission(entry, decision);
      return decision === 'allow'
        ? 'Allowed the permission prompt.'
        : 'Denied the permission prompt.';
    },

    async startAgent(input: StartAgentInput, onLateFailure) {
      const entry = need();
      let providerId = entry.providerId;
      if (input.provider) {
        const installed = await installedProviders().catch(() => []);
        // Detection that found nothing failed; the reference is then resolved among all providers.
        const match =
          installed.length > 0 ? matchInstalledProvider(input.provider, installed) : null;
        if (installed.length > 0 && !match) {
          throw new Error(
            `Provider "${input.provider}" is not installed. Installed: ${installed.map((provider) => provider.id).join(', ')}.`
          );
        }
        providerId = match?.id ?? (await resolveProviderId(input.provider));
      }
      const result = await spawnAgentTask({
        projectId: entry.projectId,
        providerId,
        taskName: input.taskName,
        prompt: input.prompt,
        worktree: input.worktree === true,
        peers: spawnPeers(canvas, (id) => projectData(getProjectStore(id))?.repositoryWorkspaceId),
      });
      const label = spokenProviderLabel(providerId);
      const failed = (why: string) => {
        log.warn('chat conductor: started agent did not come up', {
          conversationId: result.conversationId,
        });
        onLateFailure(`The ${label} agent "${result.taskName}" ${why}`);
      };
      // Its workspace can take a while (a new worktree): the turn does not wait for it.
      void startAgentSession(entry.projectId, result.taskId, result.conversationId)
        .then(async (started) => {
          if (!started) return failed('did not start. Open its chat to see why.');
          if (!result.promptDeferred) return;
          const delivered = await deliverPromptWhenReady(
            canvas,
            result.conversationId,
            input.prompt
          );
          if (!delivered) failed('started, but did not take its prompt.');
        })
        .catch((error: unknown) => failed(`could not be started: ${errorMessage(error)}`));
      return [
        `Created the chat "${result.taskName}" with a ${label} agent${input.worktree ? ' in its own worktree' : ''}; it is starting with the prompt. The thread shows the developer if it does not come up.`,
        ...result.notes,
      ].join(' ');
    },

    restart(input, onLateFailure) {
      return restartChatAgent(control(need()), input, onLateFailure);
    },

    stop() {
      return stopChatAgent(control(need()));
    },

    listAccounts() {
      return describeClaudeAccountsForChat(conversationOf(need()), Date.now());
    },

    listChats() {
      const entry = need();
      const others = canvas.agentEntries.filter(
        (other) =>
          other.projectId === entry.projectId && other.conversationId !== entry.conversationId
      );
      return formatChatList(
        others.map((other) => ({
          title: formatConversationTitleForDisplay(other.providerId, other.conversationTitle),
          taskName: other.taskName,
          provider: spokenProviderLabel(other.providerId),
          status: other.status,
          running: other.type === 'acp' || other.sessionActive,
          report: other.completionReport?.text ?? null,
        }))
      );
    },
  };
}
