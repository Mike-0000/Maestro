import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { readTerminalTail } from '@core/features/canvas/api/browser/terminal-tail';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { finalAssistantReply } from '@core/primitives/agents/api/completion-report';
import { buildPromptInjectionPayload } from '@core/primitives/prompt-injection/api/prompt-injection';

/** Pause between a bracketed paste and Enter so TUIs finish ingesting the paste first. */
const SUBMIT_DELAY_MS = 80;
const ESC = '\x1b';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendRaw(conversationId: string, data: string): Promise<void> {
  const client = await getConversationsClient();
  const result = await client.tui.sendInput({ conversationId, data });
  if (!result.success) throw new Error(`The agent did not accept input (${result.error.type}).`);
}

/** Types `text` into an agent. For TUI agents this pastes, then presses Enter when `submit`. */
export async function sendToAgent(
  entry: AgentTileEntry,
  text: string,
  submit = true
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
  const payload = buildPromptInjectionPayload({
    providerId: entry.providerId,
    text,
    forceBracketedPaste: true,
  });
  await sendRaw(entry.conversationId, payload);
  if (submit) {
    await sleep(SUBMIT_DELAY_MS);
    await sendRaw(entry.conversationId, '\r');
  }
}

/** Presses Enter in an agent (submits dictated text). */
export async function submitAgentInput(entry: AgentTileEntry): Promise<void> {
  if (entry.type === 'acp') throw new Error('Chat agents submit when you send.');
  await sendRaw(entry.conversationId, '\r');
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
