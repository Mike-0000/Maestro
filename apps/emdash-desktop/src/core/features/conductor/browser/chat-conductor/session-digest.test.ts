import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ChatDigest, PostDigestInput } from '../../api/chat-conductor/digest';
import {
  conductorTaskThreadSchema,
  type ChatConductorEntry,
  type ConductorTaskThread,
} from '../../api/chat-conductor/thread';
import type { AgentSnapshot } from './agent-event';
import { ChatConductorSession, type ChatConductorPorts, type ChatTurnResult } from './session';

/**
 * `post_digest` in a running session. A small fake of the ports of its own, so this file does not
 * depend on the shared session test harness.
 */

type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Block;
let toolId = 0;
const tool = (name: string, input: unknown = {}) =>
  ({ type: 'tool_use', id: `digest-tool-${++toolId}`, name, input }) as Block;
const says = (...content: Block[]): ChatTurnResult => ({
  success: true,
  data: { content, stopReason: 'end_turn' },
});

const working: AgentSnapshot = { status: 'working', report: null, notification: null };
const finished = (reply: string): AgentSnapshot => ({
  status: 'completed',
  report: { text: reply, truncated: false, appUrls: [] },
  notification: null,
});

const REPORT: PostDigestInput = {
  outcome: 'finished',
  headline: 'Login fix: ready to try, not merged.',
  did: ['Changed `src/auth/login.ts` to keep the session cookie', 'Ran `pnpm test auth`'],
  status: 'Tests pass. Not tried in the app yet.',
  next: 'Say "merge it" once it works for you.',
  asked: 'Fix the login that drops the session.',
  where: 'Branch `fix/login`, not merged.',
  your_move: 'Open `http://localhost:5173` and try the login.',
  app_url: 'http://localhost:5173',
};

const STORED: ChatDigest = {
  outcome: 'finished',
  headline: 'Login fix: ready to try, not merged.',
  did: ['Changed `src/auth/login.ts` to keep the session cookie', 'Ran `pnpm test auth`'],
  status: 'Tests pass. Not tried in the app yet.',
  next: 'Say "merge it" once it works for you.',
  asked: 'Fix the login that drops the session.',
  where: 'Branch `fix/login`, not merged.',
  move: 'Open `http://localhost:5173` and try the login.',
  appUrl: 'http://localhost:5173',
};

function harness(options: { thread?: ConductorTaskThread | null; autonomy?: boolean } = {}) {
  const replies: ChatTurnResult[] = [];
  const calls: Message[][] = [];
  const saved: ConductorTaskThread[] = [];
  const chat = { id: 'conv-1', name: 'Zeus', providerId: 'claude' };
  let snapshot: AgentSnapshot | null = { status: 'idle', report: null, notification: null };
  let onChange: ((chatId: string, value: AgentSnapshot | null) => void) | null = null;
  let id = 0;
  // Each stamp a minute later, so entries can be told apart by `at`.
  let minute = 0;
  const resolveDecision = vi.fn<ChatConductorPorts['resolveDecision']>();
  const agent = {
    chats: () => [
      { ...chat, providerLabel: 'Claude', status: snapshot?.status ?? 'not loaded', running: true },
    ],
    snapshot: (_chatId: string) => snapshot,
    watch: (listener: (chatId: string, value: AgentSnapshot | null) => void) => {
      onChange = listener;
      return () => (onChange = null);
    },
    facts: () => ({ taskName: 'Fix login', projectName: 'Shop' }),
    readOutput: vi.fn(async (_chatId: string, _lines: number) => 'raw output'),
    finishedReport: vi.fn(async (_chatId: string) => null),
    send: vi.fn(async (_chatId: string, _message: string, _late: (m: string) => void) => 'Sent.'),
    interrupt: vi.fn(async (_chatId: string) => 'Interrupted.'),
    answerPrompt: vi.fn(async (_chatId: string, _decision: 'allow' | 'deny') => 'Answered.'),
    startChat: vi.fn(async (_input: { name?: string }, _late: (m: string) => void) => ({
      chatId: 'conv-2',
      name: 'Hera',
      result: 'Started.',
    })),
    listChats: vi.fn(() => "This task's chats."),
    restart: vi.fn(
      async (
        _chatId: string,
        _input: { claudeAccount?: string; prompt?: string },
        _late: (m: string) => void
      ) => 'Restarted.'
    ),
    stop: vi.fn(async (_chatId: string) => 'Stopped.'),
    listAccounts: vi.fn((_chatId: string) => 'Claude accounts.'),
    chatDeleted: vi.fn((_chatId: string) => false),
    receivedPrompts: vi.fn(async (_chatId: string, cursor: number | null) => ({
      prompts: [],
      cursor: (cursor ?? 0) + 1,
    })),
  };
  const ports: ChatConductorPorts = {
    runTurn: async (messages) => {
      calls.push(structuredClone(messages));
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      return next;
    },
    readThread: async () => options.thread ?? null,
    saveThread: async (thread) => {
      saved.push(structuredClone(thread));
    },
    deleteThread: vi.fn(async () => {}),
    readLegacy: vi.fn(async () => []),
    deleteLegacy: vi.fn(async () => {}),
    agent,
    browsers: {
      list: () => [],
      open: (url: string | null) => ({ id: 'browser-1', url: url ?? 'about:blank', title: null }),
      navigate: () => {},
      close: () => {},
      devServerOrigins: () => ['http://localhost:5173'],
      publicWebEnabled: async () => false,
    },
    chatOnScreen: () => chat.id,
    ready: () => true,
    defaultAutonomy: () => options.autonomy ?? true,
    now: () => new Date(Date.UTC(2026, 10, 10, 12, minute++)),
    newId: () => `id-${++id}`,
    warn: vi.fn(),
    eventGatherMs: 0,
    resolveDecision,
    announceCompletions: () => 'attention_only',
  };
  const session = new ChatConductorSession('task-1', ports);
  return {
    session,
    resolveDecision,
    replies,
    calls,
    saved,
    agentIs: (value: AgentSnapshot | null) => {
      snapshot = value;
      onChange?.(chat.id, value);
    },
    idle: async () => {
      await vi.waitFor(() => expect(session.busy).toBe(false));
      await session.flushed();
    },
    kinds: () => session.entries.map((entry) => entry.kind),
  };
}

/** A session that already follows its chat, with the catch-up turn behind it. */
async function following(options: { autonomy?: boolean } = {}) {
  const h = harness(options);
  h.replies.push(says(text('Caught up.')));
  await h.session.attach();
  await h.idle();
  h.calls.length = 0;
  return h;
}

/** The tool results the model was given for its first round. */
function firstResults(h: ReturnType<typeof harness>): ToolResult[] {
  return h.calls[1]!.at(-1)!.content as ToolResult[];
}

function digestEntries(entries: readonly ChatConductorEntry[]) {
  return entries.flatMap((entry) => (entry.kind === 'digest' ? [entry] : []));
}

describe('post_digest in a chat conductor session', () => {
  it('posts the report as a card, then the line that ends the turn', async () => {
    const h = harness();
    h.replies.push(
      says(tool('post_digest', REPORT)),
      says(text('Login fix is ready to try, not merged yet. Want the app open?'))
    );
    h.session.send('Fix the login.');
    await h.idle();

    expect(h.kinds()).toEqual(['developer', 'digest', 'conductor']);
    const developer = h.session.entries[0]!;
    expect(h.session.entries[1]).toMatchObject({
      kind: 'digest',
      digest: STORED,
      askedAt: developer.at,
    });
    expect(h.session.entries[2]).toMatchObject({
      kind: 'conductor',
      text: 'Login fix is ready to try, not merged yet. Want the app open?',
    });
    const [result] = firstResults(h);
    expect(result!.is_error).toBeUndefined();
    expect(String(result!.content)).toContain('Report posted');
  });

  it('stamps askedAt from the newest developer entry', async () => {
    const h = await following();
    h.replies.push(says(text('On it.')));
    h.session.send('First ask.');
    await h.idle();
    h.replies.push(says(tool('post_digest', REPORT)), says(text('Done.')));
    h.session.send('Second ask.');
    await h.idle();

    const developers = h.session.entries.filter((entry) => entry.kind === 'developer');
    const [digest] = digestEntries(h.session.entries);
    expect(developers).toHaveLength(2);
    expect(developers[0]!.at).not.toBe(developers[1]!.at);
    expect(digest!.askedAt).toBe(developers[1]!.at);
  });

  it('shows the event marker before a digest posted on an event turn', async () => {
    const h = await following();
    h.replies.push(says(tool('post_digest', REPORT)), says(text('Login fix is ready to try.')));
    h.agentIs(working);
    h.agentIs(finished('All done, tests pass.'));
    await h.idle();

    expect(h.kinds().slice(-3)).toEqual(['event', 'digest', 'conductor']);
    expect(h.session.entries.at(-3)).toMatchObject({ kind: 'event', text: 'Zeus finished a turn' });
    // The developer never wrote in this thread: no age for the ask.
    expect(digestEntries(h.session.entries)[0]!.askedAt).toBeNull();
  });

  it('posts the digest on an event turn while autonomy is off', async () => {
    const h = await following({ autonomy: false });
    h.replies.push(says(tool('post_digest', REPORT)), says(text('It is finished.')));
    h.agentIs(working);
    h.agentIs(finished('All done.'));
    await h.idle();

    expect(digestEntries(h.session.entries)).toHaveLength(1);
    expect(h.session.entries.some((entry) => entry.kind === 'action')).toBe(false);
    expect(firstResults(h)[0]!.is_error).toBeUndefined();
  });

  it('turns invalid input into an error result and adds no entry', async () => {
    const h = harness();
    h.replies.push(
      says(
        tool('post_digest', { ...REPORT, did: ['a', 'b', 'c', 'd', 'e'] }),
        tool('post_digest', { ...REPORT, headline: '' })
      ),
      says(text('I could not post the report.'))
    );
    h.session.send('How did it go?');
    await h.idle();

    expect(h.kinds()).toEqual(['developer', 'conductor']);
    const results = firstResults(h);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain('Invalid input for post_digest');
    }
  });

  it('shows an event-turn error again when a digest came after the same error', async () => {
    const h = await following();
    const failed: ChatTurnResult = {
      success: false,
      error: { type: 'api-error', message: 'The budget is used up.' },
    };
    h.replies.push(failed);
    h.agentIs(working);
    h.agentIs(finished('First part done.'));
    await h.idle();
    expect(h.kinds().slice(-2)).toEqual(['event', 'error']);

    h.replies.push(says(tool('post_digest', REPORT)), failed);
    h.agentIs(working);
    h.agentIs(finished('Second part done.'));
    await h.idle();

    // The digest is news after the first error, so the same error is said again after it.
    expect(h.kinds().slice(-3)).toEqual(['event', 'digest', 'error']);
    expect(h.session.entries.at(-1)).toMatchObject({
      kind: 'error',
      text: 'The budget is used up.',
    });
  });

  it('tells the developer of a held event through the status set with the report', async () => {
    const h = await following();
    h.replies.push(
      says(
        tool('post_digest', REPORT),
        tool('set_status', { state: 'done', headline: REPORT.headline, notify: true })
      ),
      says(text('Login fix is ready to try, not merged yet.'))
    );
    const held = {
      holdId: 'hold-1',
      conversationId: 'conv-1',
      kind: 'finished' as const,
      completionReport: { text: 'All done, tests pass.', truncated: false, appUrls: [] },
      decideBy: Date.UTC(2027, 0, 1),
    };
    expect(h.session.decide(held)).toBe(true);
    await h.idle();

    expect(digestEntries(h.session.entries)).toHaveLength(1);
    expect(h.resolveDecision).toHaveBeenCalledTimes(1);
    expect(h.resolveDecision).toHaveBeenCalledWith('hold-1', 'conv-1', {
      kind: 'surface',
      state: 'done',
      headline: REPORT.headline,
      notify: true,
    });

    // A report with no status tells the developer nothing of the event.
    h.replies.push(says(tool('post_digest', REPORT)), says(text('Ready to try.')));
    h.session.decide({ ...held, holdId: 'hold-2' });
    await h.idle();
    expect(h.resolveDecision).toHaveBeenLastCalledWith('hold-2', 'conv-1', { kind: 'quiet' });
  });

  it('keeps the digest through a save and a load', async () => {
    const h = harness();
    h.replies.push(says(tool('post_digest', REPORT)), says(text('Ready to try.')));
    h.session.send('Fix the login.');
    await h.idle();

    const thread = h.saved.at(-1)!;
    // Through JSON and the schema, as the thread file is written and read.
    const parsed = conductorTaskThreadSchema.parse(JSON.parse(JSON.stringify(thread)));
    expect(digestEntries(parsed.entries)).toEqual(digestEntries(h.session.entries));

    const again = harness({ thread: parsed });
    await again.session.load();
    expect(again.session.entries).toEqual(h.session.entries);
    expect(digestEntries(again.session.entries)[0]).toMatchObject({
      digest: STORED,
      askedAt: h.session.entries[0]!.at,
    });
  });
});
