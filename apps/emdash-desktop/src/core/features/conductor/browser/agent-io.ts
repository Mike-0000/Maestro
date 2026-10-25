import { reaction } from 'mobx';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { readTerminalTail } from '@core/features/canvas/api/browser/terminal-tail';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  clearUnsentMark,
  developerTypedSince,
  forgetDeveloperTyping,
  noteConductorSubmit,
  noteDictatedText,
  noteUnsentMessage,
} from '@core/features/terminals/api/browser/pty/developer-typing';
import { finalAssistantReply } from '@core/primitives/agents/api/completion-report';
import { buildPromptInjectionPayload } from '@core/primitives/prompt-injection/api/prompt-injection';
import { type DeliveryHold, emitDelivery, queueDelivery, writeToInput } from './delivery-lane';

/** Pause between a bracketed paste and Enter so TUIs finish ingesting the paste first. */
const SUBMIT_DELAY_MS = 80;
/**
 * Codex turns an Enter that arrives while it is still reading a paste into a newline instead of a
 * submit. On Windows the paste reaches it as a keystroke burst, and a long one can take longer to
 * read than any fixed pause, so Codex gets a longer pause and then a check that the turn started.
 */
const CODEX_SUBMIT_DELAY_MS = 500;
/** How long Codex gets to show its working status after Enter before Enter is pressed again. */
const CODEX_SUBMIT_CHECK_MS = 1_500;
/** How often its screen is read in that time, so a started turn ends the wait early. */
const CODEX_SUBMIT_POLL_MS = 150;
const CODEX_SUBMIT_ATTEMPTS = 3;
/**
 * Codex's status line reads "• Working (0s • esc to interrupt)" while a turn runs (newer builds
 * capitalize "Esc"); only the hint is matched, so a changed header word still counts.
 */
const CODEX_WORKING = /to interrupt/i;
/** Rows read above the bottom of what Codex drew: its status line sits over the composer. */
const CODEX_STATUS_ROWS = 12;
const ESC = '\x1b';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a send can be told while it runs. */
export interface SendOptions {
  /**
   * False for the developer's own words: no waiting for their typing and no queue; it goes ahead
   * of held messages. It still refuses to type into a prompt.
   */
  waitForTyping?: boolean;
  /** Told once, as soon as the send is held for the developer's typing. See `delivery-lane`. */
  onHold?: (hold: DeliveryHold) => void;
}

/**
 * Pasted into Codex, but the turn never started: the text waits in its composer. Sending again
 * would paste it twice, so the caller says so instead.
 */
export class CodexNotStartedError extends Error {
  /** The text is in the agent's input. */
  readonly pasted = true;
  constructor(agentName: string) {
    super(`Pasted into ${agentName}, but Codex didn't start; press Enter in its window.`);
    this.name = 'CodexNotStartedError';
  }
}

/**
 * Pasted, but not submitted: the developer typed in that terminal before the agent took it, and
 * Enter now would send their keys with it. Both wait in its input for the developer to send.
 */
export class DeliveryLeftUnsentError extends Error {
  /** The text is in the agent's input. */
  readonly pasted = true;
  constructor(agentName: string) {
    super(`Left in ${agentName}'s input because you were typing there; press Enter when ready.`);
    this.name = 'DeliveryLeftUnsentError';
  }
}

/** How long a message marked unsent waits for its agent to show it took it after all. */
const UNSENT_WATCH_MS = 60 * 60_000;
const unsentWatches = new Map<string, () => void>();

/**
 * Marks a pasted message as still in the agent's input, so the next one waits rather than being
 * submitted with it, and clears the mark if the agent shows it took the message after all: a
 * finished turn or a prompt (both from its hooks) means a turn ran. "Working" does not count: the
 * host reports it on any Enter for agents without a start hook, Codex among them.
 */
function markUnsent(entry: AgentTileEntry): void {
  noteUnsentMessage(entry.conversationId);
  unsentWatches.get(entry.conversationId)?.();
  const conversation = liveConversation(entry);
  if (!conversation) return;
  const stop = () => {
    disposeReaction();
    clearTimeout(timer);
    if (unsentWatches.get(entry.conversationId) === stop)
      unsentWatches.delete(entry.conversationId);
  };
  const disposeReaction = reaction(
    // A new report changes even when the status stays "completed".
    () => [conversation.status, conversation.completionReport] as const,
    ([status]) => {
      if (status !== 'completed' && status !== 'awaiting-input' && status !== 'error') return;
      clearUnsentMark(entry.conversationId);
      stop();
    }
  );
  const timer = setTimeout(stop, UNSENT_WATCH_MS);
  unsentWatches.set(entry.conversationId, stop);
}

/** Writes to an agent's terminal. Resolves to the error type when the host refused it. */
async function writeInput(conversationId: string, data: string): Promise<string | null> {
  const client = await getConversationsClient();
  const result = await client.tui.sendInput({ conversationId, data });
  return result.success ? null : result.error.type;
}

async function sendRaw(conversationId: string, data: string): Promise<void> {
  const refused = await writeInput(conversationId, data);
  if (refused) throw new Error(`The agent did not accept input (${refused}).`);
}

function pastePayload(entry: AgentTileEntry, text: string): string {
  return buildPromptInjectionPayload({
    providerId: entry.providerId,
    text,
    forceBracketedPaste: true,
  });
}

async function pressEnterAfterPaste(entry: AgentTileEntry, pastedAt: number): Promise<void> {
  if (entry.providerId === 'codex') {
    await submitCodexPaste(entry, pastedAt);
    return;
  }
  await sleep(SUBMIT_DELAY_MS);
  await sendRaw(entry.conversationId, '\r');
  noteConductorSubmit(entry.conversationId);
}

function liveConversation(entry: AgentTileEntry) {
  return conversationRegistry.get(entry.taskId)?.conversations.get(entry.conversationId);
}

/** Whether the agent shows a prompt typing would answer, from its live status (not the snapshot). */
function atPromptNow(entry: AgentTileEntry): boolean {
  const conversation = liveConversation(entry);
  return (
    conversation?.status === 'awaiting-input' &&
    (conversation.lastNotificationType === 'permission_prompt' ||
      conversation.lastNotificationType === 'elicitation_dialog')
  );
}

type CodexTurn = 'working' | 'prompt' | 'idle';

/**
 * Whether Codex started the turn: its status line shows, or its permission hook reported a
 * prompt that was not up before the paste. Null when its terminal cannot be read.
 *
 * The bottom of what Codex drew is read, not the bottom of the screen: Codex draws inline from
 * where the cursor was, so in a fresh session its status and composer sit near the top with blank
 * rows under them, and the screen's last rows hold nothing.
 */
async function codexTurn(entry: AgentTileEntry, promptBefore: boolean): Promise<CodexTurn | null> {
  if (!promptBefore && atPromptNow(entry)) return 'prompt';
  const session = conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId);
  if (!session) return null;
  await session.connect().catch(() => {});
  const terminal = session.pty?.terminal;
  if (!terminal) return null;
  const drawn = readTerminalTail(terminal, terminal.rows).slice(-CODEX_STATUS_ROWS);
  return CODEX_WORKING.test(drawn.join('\n')) ? 'working' : 'idle';
}

/** Reads Codex's screen until the turn shows or `CODEX_SUBMIT_CHECK_MS` passes. */
async function awaitCodexTurn(
  entry: AgentTileEntry,
  promptBefore: boolean
): Promise<CodexTurn | null> {
  const deadline = Date.now() + CODEX_SUBMIT_CHECK_MS;
  for (;;) {
    await sleep(Math.min(CODEX_SUBMIT_POLL_MS, Math.max(0, deadline - Date.now())));
    const turn = await codexTurn(entry, promptBefore);
    if (turn !== 'idle' || Date.now() >= deadline) return turn;
  }
}

/**
 * Presses Enter until Codex starts the turn. An Enter it read as part of the paste only added a
 * newline, so another one submits. Enter is pressed again only while no turn runs, so it can never
 * answer a permission prompt the turn raised, and never once the developer typed there since the
 * paste: it would submit their keys with the message (`DeliveryLeftUnsentError`). Each attempt is
 * reported (see `onAgentDelivery`); when the last one still started nothing, it throws
 * `CodexNotStartedError`.
 */
async function submitCodexPaste(entry: AgentTileEntry, pastedAt: number): Promise<void> {
  const promptBefore = atPromptNow(entry);
  const report = (attempts: number, outcome: string, startedOn: number | null) =>
    emitDelivery({
      type: 'submit',
      conversationId: entry.conversationId,
      providerId: entry.providerId,
      detail: { attempts, outcome, startedOn, ms: Date.now() - pastedAt },
    });
  await sleep(CODEX_SUBMIT_DELAY_MS);
  for (let attempt = 1; attempt <= CODEX_SUBMIT_ATTEMPTS; attempt++) {
    await sendRaw(entry.conversationId, '\r');
    const turn = await awaitCodexTurn(entry, promptBefore);
    if (turn !== 'idle') {
      // An unreadable screen is taken as a submit, as it always was: Enter is not pressed again.
      noteConductorSubmit(entry.conversationId);
      report(attempt, turn ?? 'unreadable', turn ? attempt : null);
      return;
    }
    if (developerTypedSince(entry.conversationId, pastedAt)) {
      // Their keys and the message share the composer now; the developer sends them.
      report(attempt, 'developer-typed', null);
      markUnsent(entry);
      throw new DeliveryLeftUnsentError(entry.taskName);
    }
  }
  report(CODEX_SUBMIT_ATTEMPTS, 'not-started', null);
  // The message waits in the composer; another one must not be pasted and submitted with it.
  markUnsent(entry);
  throw new CodexNotStartedError(entry.taskName);
}

/** Pastes `text` and presses Enter, queued behind other messages to the agent (`delivery-lane`). */
function pasteAndSubmit<T>(
  entry: AgentTileEntry,
  options: SendOptions,
  paste: () => Promise<T>,
  pasted: (result: T) => boolean
): Promise<T> {
  return queueDelivery(
    entry.conversationId,
    async () => {
      const result = await paste();
      if (pasted(result)) await pressEnterAfterPaste(entry, Date.now());
      return result;
    },
    {
      agentName: entry.taskName,
      waitForTyping: options.waitForTyping,
      onHold: options.onHold,
      blockedNow: () => (atPromptNow(entry) ? 'prompt' : null),
    }
  );
}

/**
 * Types `text` into a terminal agent the session list calls stopped, when its host still has the
 * session. The list can trail the host (it is a subscription; input is routed by the host itself),
 * and a running agent must never be started a second time. Resolves false when the host has no
 * such session, so the caller can start it. A submitted send waits like `sendToAgent`'s.
 */
export async function sendToLiveSession(
  entry: AgentTileEntry,
  text: string,
  submit = true,
  options: SendOptions = {}
): Promise<boolean> {
  if (entry.type === 'acp') return false;
  const paste = async (): Promise<boolean> => {
    const refused = await writeInput(entry.conversationId, pastePayload(entry, text));
    if (refused === 'not-found') return false;
    if (refused) throw new Error(`The agent did not accept input (${refused}).`);
    return true;
  };
  if (!submit) {
    const typed = await writeToInput(entry.conversationId, paste);
    if (typed) noteDictatedText(entry.conversationId);
    return typed;
  }
  return pasteAndSubmit(entry, options, paste, (typed) => typed);
}

/**
 * Types `text` into an agent. For TUI agents this pastes, then presses Enter when `submit`.
 *
 * A submitted message waits while the developer is typing in that terminal, and goes after the
 * messages to the agent queued before it, each submitted on its own (see `delivery-lane`). It can
 * then reject with `DeliveryHeldError` (held too long, or at a prompt), or for Codex with
 * `CodexNotStartedError` or `DeliveryLeftUnsentError` (pasted, not submitted).
 * Text typed without Enter (dictation) neither waits nor queues.
 */
export async function sendToAgent(
  entry: AgentTileEntry,
  text: string,
  submit = true,
  options: SendOptions = {}
): Promise<void> {
  if (entry.type === 'acp') {
    const client = await getConversationsClient();
    const result = await client.acp.sendPrompt(
      {
        conversationId: entry.conversationId,
        promptId: crypto.randomUUID(),
        prompt: { text },
        placement: 'auto',
      },
      { timeoutMs: 0 }
    );
    if (!result.success) throw new Error('The chat agent did not accept the prompt.');
    return;
  }
  if (!entry.sessionActive) throw new Error(`${entry.taskName} is not running. Resume it first.`);
  const paste = () => sendRaw(entry.conversationId, pastePayload(entry, text));
  if (!submit) {
    await writeToInput(entry.conversationId, paste);
    noteDictatedText(entry.conversationId);
    return;
  }
  await pasteAndSubmit(entry, options, paste, () => true);
}

/** Presses Enter in an agent (submits dictated text). */
export async function submitAgentInput(entry: AgentTileEntry): Promise<void> {
  if (entry.type === 'acp') throw new Error('Chat agents submit when you send.');
  await writeToInput(entry.conversationId, () => sendRaw(entry.conversationId, '\r'));
  noteConductorSubmit(entry.conversationId);
}

/** Interrupts a working agent (Escape for TUI agents, turn cancellation for chat agents). */
export async function interruptAgent(entry: AgentTileEntry): Promise<void> {
  if (entry.type === 'acp') {
    const client = await getConversationsClient();
    await client.acp.cancelTurn({ conversationId: entry.conversationId });
    return;
  }
  await sendRaw(entry.conversationId, ESC);
}

/**
 * Ends an agent's session (kills the TUI process or terminates the chat session). The
 * conversation stays on the task and can be resumed later.
 */
export async function stopAgentSession(entry: AgentTileEntry): Promise<void> {
  const manager = conversationRegistry.get(entry.taskId);
  if (!manager) throw new Error(`${entry.taskName} is not loaded.`);
  await manager.killSession(entry.conversationId);
  // Its input went with the process.
  forgetDeveloperTyping(entry.conversationId);
}

/**
 * Answers a pending permission prompt. Claude Code and Codex both highlight "allow once" by
 * default, so Enter accepts it; Escape declines.
 */
export async function answerPermission(
  entry: AgentTileEntry,
  decision: 'allow' | 'deny'
): Promise<void> {
  if (entry.type === 'acp') {
    throw new Error('Answer chat-agent permission requests in its tile.');
  }
  await sendRaw(entry.conversationId, decision === 'allow' ? '\r' : ESC);
}

/** Recent output of an agent as plain text (terminal tail, or the chat transcript tail). */
export async function readAgentOutput(entry: AgentTileEntry, lines = 40): Promise<string> {
  if (entry.type === 'acp') {
    const client = await getConversationsClient();
    const result = await client.acp.exportAcpTranscript({ conversationId: entry.conversationId });
    if (!result.success) return '(the chat transcript is not available)';
    return result.data.transcript.split('\n').slice(-lines).join('\n');
  }
  const session = conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId);
  if (!session) return '(no terminal session)';
  // Connecting subscribes to output (replaying the host ring buffer); it never starts the agent.
  await session.connect().catch(() => {});
  const terminal = session.pty?.terminal;
  if (!terminal) return '(no output yet)';
  return readTerminalTail(terminal, lines).join('\n');
}

/** Chat transcripts can trail the completion event by a moment; one retry covers it. */
const CHAT_REPLY_RETRY_MS = 500;

/**
 * A chat (ACP) agent's final reply in its latest turn: the assistant text after its last tool
 * call, never its thinking. TUI agents report theirs through their Stop hook instead.
 */
export async function readFinalChatReply(entry: AgentTileEntry): Promise<string | null> {
  if (entry.type !== 'acp') return null;
  const client = await getConversationsClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(CHAT_REPLY_RETRY_MS);
    const result = await client.acp.loadHistory({ conversationId: entry.conversationId, limit: 1 });
    if (!result.success || result.data.unavailable) continue;
    const turn = result.data.turns.at(-1);
    const reply = turn ? finalAssistantReply(turn.items) : null;
    if (reply) return reply;
  }
  return null;
}

/** Rows of a TUI agent's terminal read when it finished without reporting a reply. */
const FINISHED_TERMINAL_ROWS = 200;
/** A completion can land a frame before the TUI paints its closing message. */
const TERMINAL_SETTLE_MS = 300;

/**
 * The recent terminal text of a TUI agent that just finished, for agents whose completion carried
 * no reply (see `terminalTailReport`). Null for chat agents or when there is no terminal.
 */
export async function readFinishedTerminal(entry: AgentTileEntry): Promise<string | null> {
  if (entry.type === 'acp') return null;
  const session = conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId);
  if (!session) return null;
  await session.connect().catch(() => {});
  await sleep(TERMINAL_SETTLE_MS);
  const terminal = session.pty?.terminal;
  return terminal ? readTerminalTail(terminal, FINISHED_TERMINAL_ROWS).join('\n') : null;
}

/** The last meaningful line of output, for one-sentence spoken status. */
export async function lastMeaningfulLine(entry: AgentTileEntry): Promise<string | null> {
  const output = await readAgentOutput(entry, 30);
  const lines = output
    .split('\n')
    .map((line) => line.replace(/[│┃╭╮╰╯─━═╌]+/g, ' ').trim())
    .filter((line) => line.length > 3 && /[a-z]/i.test(line));
  return lines[lines.length - 1] ?? null;
}
