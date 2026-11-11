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
 * Codex swallows an Enter that arrives while it is still reading a paste: on Windows the paste
 * reaches it through ConPTY as a keystroke burst, which it buffers and draws only once the burst
 * ends, and an Enter inside the burst does not submit. Reading takes about 0.6 ms a character
 * (measured Nov 10 on Windows, codex-cli 0.164, idle machine: 80 chars drawn after 0.19 s, 561
 * after 0.42 s, 1,541 after 0.97 s, 2,962 after 1.75 s, 5,972 after 3.4 s, 11,972 after 7.4 s), so
 * no fixed pause fits: Enter waits until the composer shows the paste and has been still a moment.
 */
const CODEX_PASTE_QUIET_MS = 200;
/**
 * The longest Codex gets to show the paste: well over the measured rate, for a loaded machine.
 * When it never shows (an unrecognized screen), Enter goes after this anyway, by then safely late.
 */
const CODEX_INGEST_BASE_MS = 2_000;
const CODEX_INGEST_MS_PER_CHAR = 1.5;
const CODEX_INGEST_MAX_MS = 60_000;
/** With no screen to read, the pause before Enter: the measured rate with a margin. */
const CODEX_BLIND_BASE_MS = 500;
const CODEX_BLIND_MS_PER_CHAR = 1;
/** How long Codex gets to take the message after Enter before Enter is pressed again. */
const CODEX_SUBMIT_CHECK_MS = 2_000;
/** How often its screen is read while waiting. */
const CODEX_POLL_MS = 50;
const CODEX_SUBMIT_ATTEMPTS = 3;
/**
 * Codex's status line reads "• Working (0s • esc to interrupt)" while a turn runs (newer builds
 * capitalize "Esc"); only the hint is matched, so a changed header word still counts.
 */
const CODEX_WORKING = /to interrupt/i;
/** Rows read above the bottom of what Codex drew: its status line sits over the composer. */
const CODEX_STATUS_ROWS = 12;
/**
 * Codex's selection popups (update offer, folder trust, "approaching rate limits", approvals) end
 * with a key hint such as "enter select · esc back" or "enter continue · esc skip". Pasted text
 * moves their selection (it arrives as keys) and Enter picks an option, so nothing is typed while
 * one is up.
 */
const CODEX_MENU_HINT = /\benter (?:to )?(?:select|continue|confirm)\b/i;
/** The composer's first row starts with this glyph (as does a popup's selected row). */
const CODEX_COMPOSER_GLYPH = '›';
/** Non-space characters from the end of a message that identify it in Codex's composer. */
const CODEX_FINGERPRINT_CHARS = 24;
const CODEX_PASTED_PLACEHOLDER = /\[Pasted Content \d+ chars\]/;
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
  /**
   * The text is the developer's own dictated words: once submitted it is recorded as their
   * prompt, for the chat conductor (see `developerSubmissionsSince`).
   */
  dictated?: boolean;
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

async function pressEnterAfterPaste(
  entry: AgentTileEntry,
  pastedAt: number,
  text: string,
  before: CodexBefore | null
): Promise<void> {
  if (entry.providerId === 'codex') {
    await submitCodexPaste(entry, pastedAt, text, before ?? { workingBefore: false });
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

/** Connects the agent's terminal so its screen can be read; it never starts the agent. */
async function connectTerminal(entry: AgentTileEntry): Promise<void> {
  const session = conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId);
  await session?.connect().catch(() => {});
}

/**
 * What Codex drew, top to bottom, without the blank rows under it. Codex draws inline from where
 * the cursor was, so in a fresh session its status and composer sit near the top with blank rows
 * under them: the bottom of what it drew is read, not the bottom of the screen. Null when its
 * terminal cannot be read.
 */
function codexScreen(entry: AgentTileEntry): string[] | null {
  const terminal = conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId)
    ?.pty?.terminal;
  return terminal ? readTerminalTail(terminal, terminal.rows) : null;
}

/** Whether Codex's status line shows a running turn. */
export function codexShowsWorking(screen: string[]): boolean {
  return CODEX_WORKING.test(screen.slice(-CODEX_STATUS_ROWS).join('\n'));
}

/** Whether Codex shows a selection popup that pasted keys would move and Enter would answer. */
export function codexShowsMenu(screen: string[]): boolean {
  return screen.slice(-2).some((row) => CODEX_MENU_HINT.test(row));
}

/**
 * Codex's composer: the rows from the last one starting with its glyph to the bottom, so a
 * submitted message echoed in the history above is not in it. Null when no composer shows.
 */
export function codexComposer(screen: string[]): string | null {
  for (let index = screen.length - 1; index >= 0; index--) {
    if (screen[index]?.startsWith(CODEX_COMPOSER_GLYPH)) return screen.slice(index).join('\n');
  }
  return null;
}

const squash = (value: string) => value.replace(/\s+/g, '');

/**
 * Whether Codex's composer holds `text`: its placeholder for a long paste, or the end of the text
 * (spaces ignored, since the composer wraps and indents it). Null when no composer shows.
 */
export function codexComposerHolds(screen: string[], text: string): boolean | null {
  const composer = codexComposer(screen);
  if (composer === null) return null;
  if (CODEX_PASTED_PLACEHOLDER.test(composer)) return true;
  const fingerprint = squash(text.trim()).slice(-CODEX_FINGERPRINT_CHARS);
  return fingerprint.length > 0 && squash(composer).includes(fingerprint);
}

/** How long Codex may take to show a paste of `chars` characters. */
export function codexIngestBudgetMs(chars: number): number {
  return Math.min(CODEX_INGEST_MAX_MS, CODEX_INGEST_BASE_MS + chars * CODEX_INGEST_MS_PER_CHAR);
}

/** What Codex showed right before the paste. */
interface CodexBefore {
  /**
   * A turn was already running: its status line is then no sign that this message started one,
   * and only the composer emptying is.
   */
  workingBefore: boolean;
}

function codexBefore(entry: AgentTileEntry): CodexBefore {
  const screen = codexScreen(entry);
  return { workingBefore: screen ? codexShowsWorking(screen) : false };
}

/**
 * Waits until Codex's composer shows the paste and has stayed the same for
 * `CODEX_PASTE_QUIET_MS`, so it has read the whole burst. Resolves when it landed (ms after the
 * paste), 'unseen' when the budget ran out without the composer showing it, or null when the
 * screen cannot be read.
 */
async function awaitCodexPaste(
  entry: AgentTileEntry,
  text: string,
  pastedAt: number,
  budgetMs: number
): Promise<number | 'unseen' | null> {
  const deadline = pastedAt + budgetMs;
  let landedAt: number | null = null;
  let composer: string | null = null;
  let stillSince = Date.now();
  for (;;) {
    const screen = codexScreen(entry);
    if (!screen) return null;
    const now = Date.now();
    const current = codexComposer(screen);
    if (current !== composer) {
      composer = current;
      stillSince = now;
    }
    if (landedAt === null && codexComposerHolds(screen, text)) landedAt = now;
    // A popup is up: waiting longer changes nothing, and the caller must not press Enter.
    if (codexShowsMenu(screen)) return landedAt === null ? 'unseen' : landedAt - pastedAt;
    if (landedAt !== null && now - stillSince >= CODEX_PASTE_QUIET_MS) return landedAt - pastedAt;
    if (now >= deadline) return landedAt === null ? 'unseen' : landedAt - pastedAt;
    await sleep(Math.min(CODEX_POLL_MS, Math.max(0, deadline - now)));
  }
}

type CodexSubmit = 'working' | 'sent' | 'prompt';

/**
 * Reads Codex's screen after Enter until it shows it took the message, or `CODEX_SUBMIT_CHECK_MS`
 * passes ('pending'). Taken means: its hook reported a prompt that was not up before; a turn's
 * status line that was not showing before the paste; or (when the paste was seen in the composer)
 * a composer that no longer holds it, on two reads in a row so a half-drawn frame does not count.
 * Null when the screen cannot be read.
 */
async function awaitCodexSubmit(
  entry: AgentTileEntry,
  text: string,
  promptBefore: boolean,
  before: CodexBefore,
  landed: boolean
): Promise<CodexSubmit | 'pending' | null> {
  const deadline = Date.now() + CODEX_SUBMIT_CHECK_MS;
  let emptied = 0;
  for (;;) {
    await sleep(Math.min(CODEX_POLL_MS, Math.max(0, deadline - Date.now())));
    if (!promptBefore && atPromptNow(entry)) return 'prompt';
    const screen = codexScreen(entry);
    if (!screen) return null;
    if (!before.workingBefore && codexShowsWorking(screen)) return 'working';
    emptied = landed && codexComposerHolds(screen, text) === false ? emptied + 1 : 0;
    if (emptied >= 2) return 'sent';
    if (Date.now() >= deadline) return 'pending';
  }
}

/**
 * Presses Enter once Codex has read the whole paste, and confirms it took the message: its turn
 * started (status line or a new prompt) or its composer emptied. Without that it presses Enter
 * again, at most `CODEX_SUBMIT_ATTEMPTS` times in all, and never into a prompt or popup, and never
 * once the developer typed there since the paste: it would submit their keys with the message
 * (`DeliveryLeftUnsentError`). When the last attempt still showed nothing it throws
 * `CodexNotStartedError`. Each delivery is reported (see `onAgentDelivery`).
 *
 * With no screen to read it waits a pause scaled to the paste and presses Enter once, reported as
 * 'unverified': nothing can confirm it, and nothing safe can be done about it either.
 */
async function submitCodexPaste(
  entry: AgentTileEntry,
  pastedAt: number,
  text: string,
  before: CodexBefore
): Promise<void> {
  const promptBefore = atPromptNow(entry);
  const chars = text.trim().length;
  let landedMs: number | null = null;
  const report = (attempts: number, outcome: string, startedOn: number | null) =>
    emitDelivery({
      type: 'submit',
      conversationId: entry.conversationId,
      providerId: entry.providerId,
      detail: {
        attempts,
        outcome,
        startedOn,
        ms: Date.now() - pastedAt,
        chars,
        landedMs,
        workingBefore: before.workingBefore,
      },
    });
  const blind = (attempts: number) => {
    noteConductorSubmit(entry.conversationId);
    report(attempts, 'unverified', null);
  };
  /** The message waits in the composer; another one must not be pasted and submitted with it. */
  const leftUnsent = (attempts: number, outcome: string, error: Error, inComposer = true) => {
    report(attempts, outcome, null);
    if (inComposer) markUnsent(entry);
    return error;
  };

  const landed = await awaitCodexPaste(entry, text, pastedAt, codexIngestBudgetMs(chars));
  if (landed === null) {
    await sleep(Math.max(0, pastedAt + codexBlindWaitMs(chars) - Date.now()));
    await sendRaw(entry.conversationId, '\r');
    blind(1);
    return;
  }
  if (typeof landed === 'number') landedMs = landed;
  for (let attempt = 1; attempt <= CODEX_SUBMIT_ATTEMPTS; attempt++) {
    if (attempt > 1 && landedMs !== null) {
      // Still in the composer: the last Enter was read with the paste. Let it settle again.
      await awaitCodexPaste(entry, text, Date.now(), CODEX_PASTE_QUIET_MS * 4);
    }
    // Checked before every Enter: their keys, a prompt or a popup would take it instead.
    if (developerTypedSince(entry.conversationId, pastedAt)) {
      throw leftUnsent(attempt - 1, 'developer-typed', new DeliveryLeftUnsentError(entry.taskName));
    }
    if (atPromptNow(entry) || codexMenuNow(entry)) {
      // A popup up before the message showed took its keys: nothing waits in the composer.
      const error = new CodexNotStartedError(entry.taskName);
      throw leftUnsent(attempt - 1, 'menu', error, landedMs !== null);
    }
    await sendRaw(entry.conversationId, '\r');
    const taken = await awaitCodexSubmit(entry, text, promptBefore, before, landedMs !== null);
    if (taken === null) {
      blind(attempt);
      return;
    }
    if (taken !== 'pending') {
      noteConductorSubmit(entry.conversationId);
      report(attempt, taken, attempt);
      return;
    }
  }
  if (developerTypedSince(entry.conversationId, pastedAt)) {
    throw leftUnsent(
      CODEX_SUBMIT_ATTEMPTS,
      'developer-typed',
      new DeliveryLeftUnsentError(entry.taskName)
    );
  }
  throw leftUnsent(CODEX_SUBMIT_ATTEMPTS, 'not-started', new CodexNotStartedError(entry.taskName));
}

/** With no screen to read, how long after the paste Enter is pressed. */
export function codexBlindWaitMs(chars: number): number {
  return Math.min(CODEX_INGEST_MAX_MS, CODEX_BLIND_BASE_MS + chars * CODEX_BLIND_MS_PER_CHAR);
}

/**
 * Pastes `text` and presses Enter, queued behind other messages to the agent (`delivery-lane`).
 * For Codex its terminal is connected first so the paste can be watched, and the message is held
 * while Codex shows a popup, like a prompt.
 */
function pasteAndSubmit<T>(
  entry: AgentTileEntry,
  options: SendOptions,
  text: string,
  paste: () => Promise<T>,
  pasted: (result: T) => boolean
): Promise<T> {
  const codex = entry.providerId === 'codex';
  // Started now, awaited under the lock: the queue must see holds synchronously.
  const connected = codex ? connectTerminal(entry) : Promise.resolve();
  return queueDelivery(
    entry.conversationId,
    async () => {
      await connected;
      const before = codex ? codexBefore(entry) : null;
      const result = await paste();
      if (pasted(result)) await pressEnterAfterPaste(entry, Date.now(), text, before);
      return result;
    },
    {
      agentName: entry.taskName,
      waitForTyping: options.waitForTyping,
      onHold: options.onHold,
      blockedNow: () => (atPromptNow(entry) || (codex && codexMenuNow(entry)) ? 'prompt' : null),
    }
  );
}

/** Whether Codex shows a popup now (false when its screen cannot be read). */
function codexMenuNow(entry: AgentTileEntry): boolean {
  const screen = codexScreen(entry);
  return screen !== null && codexShowsMenu(screen);
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
    if (typed) noteDictatedText(entry.conversationId, text);
    return typed;
  }
  return pasteAndSubmit(entry, options, text, paste, (typed) => typed);
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
    noteDictatedText(entry.conversationId, text);
    return;
  }
  const pasteWords = async () => {
    await paste();
    // In the input with whatever the developer typed there: the Enter submits both as theirs.
    if (options.dictated) noteDictatedText(entry.conversationId, text);
  };
  await pasteAndSubmit(entry, options, text, pasteWords, () => true);
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
