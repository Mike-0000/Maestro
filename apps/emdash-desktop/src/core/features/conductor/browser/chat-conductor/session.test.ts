import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ConductorDecision } from '@core/primitives/agents/api/conductor-decisions';
import { CHAT_NOTHING_NEW } from '../../api/chat-conductor/prompt';
import type { ConductorTaskThread } from '../../api/chat-conductor/thread';
import {
  CHAT_CONDUCTOR_MARK,
  CHAT_EVENT_MARK,
  markedForAgent,
  MAX_UNATTENDED_ACTIONS,
  type SubmittedPrompt,
} from '../../api/chat-conductor/turns';
import type { AgentSnapshot } from './agent-event';
import {
  CATCH_UP_REQUEST,
  ChatConductorSession,
  MAX_TURN_ROUNDS,
  type ChatConductorPorts,
  type ChatTurnResult,
  type LegacyThread,
  type TaskBrowser,
} from './session';

type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;

const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Block;
let toolId = 0;
const tool = (name: string, input: unknown = {}) =>
  ({ type: 'tool_use', id: `tool-${++toolId}`, name, input }) as Block;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type Chat = { id: string; name: string; providerId: string };

function harness(
  options: { thread?: ConductorTaskThread | null; autonomy?: boolean; chats?: Chat[] } = {}
) {
  const replies: (ChatTurnResult | Promise<ChatTurnResult> | Error)[] = [];
  const calls: Message[][] = [];
  const saved: ConductorTaskThread[] = [];
  let ready = true;
  const chats: Chat[] = options.chats ?? [{ id: 'conv-1', name: 'Zeus', providerId: 'claude' }];
  const snapshots = new Map<string, AgentSnapshot | null>(
    chats.map((chat) => [chat.id, { status: 'idle', report: null, notification: null }])
  );
  let onChange: ((chatId: string, value: AgentSnapshot | null) => void) | null = null;
  let id = 0;
  let onScreen: string | null = chats[0]?.id ?? null;
  const received: SubmittedPrompt[] = [];
  let cursor = 0;
  const agent = {
    chats: () =>
      chats.map((chat) => ({
        ...chat,
        providerLabel: chat.providerId === 'codex' ? 'Codex' : 'Claude',
        status: snapshots.get(chat.id)?.status ?? 'not loaded',
        running: true,
      })),
    snapshot: (chatId: string) => snapshots.get(chatId) ?? null,
    watch: (listener: (chatId: string, value: AgentSnapshot | null) => void) => {
      onChange = listener;
      return () => (onChange = null);
    },
    facts: () => ({ taskName: 'Fix login', projectName: 'Shop' }),
    readOutput: vi.fn(async (_chatId: string, _lines: number) => 'raw output'),
    finishedReport: vi.fn(async (_chatId: string) => null),
    send: vi.fn(
      async (_chatId: string, _message: string, _late: (message: string) => void) =>
        'Sent to the agent.'
    ),
    interrupt: vi.fn(async (_chatId: string) => 'Interrupted the agent.'),
    answerPrompt: vi.fn(
      async (_chatId: string, _decision: 'allow' | 'deny') => 'Allowed the permission prompt.'
    ),
    startChat: vi.fn(async (input: { name?: string }, _late: (message: string) => void) => {
      const chat = {
        id: `conv-${chats.length + 1}`,
        name: input.name ?? 'Hera',
        providerId: 'codex',
      };
      chats.push(chat);
      snapshots.set(chat.id, { status: 'working', report: null, notification: null });
      return { chatId: chat.id, name: chat.name, result: 'Started the chat.' };
    }),
    listChats: vi.fn(() => "This task's chats."),
    restart: vi.fn(
      async (
        _chatId: string,
        _input: { claudeAccount?: string; prompt?: string },
        _onLateFailure: (message: string) => void
      ) => 'Stopped the session and started it again.'
    ),
    stop: vi.fn(async (_chatId: string) => 'Stopped the session.'),
    listAccounts: vi.fn((_chatId: string) => 'Claude accounts:\n- Primary\n- Work'),
    chatDeleted: vi.fn((_chatId: string) => false),
    /** What the agent received since the cursor; tests push prompts into `received`. */
    receivedPrompts: vi.fn(async (_chatId: string, _cursor: number | null) => ({
      prompts: received.splice(0),
      cursor: ++cursor,
    })),
  };
  const announce: { mode: 'all' | 'attention_only' } = { mode: 'all' };
  const tabs: TaskBrowser[] = [];
  const browsers = {
    devOrigins: ['http://localhost:5173'],
    publicWeb: false,
    list: vi.fn(() => tabs.map((tab) => ({ ...tab }))),
    open: vi.fn((url: string | null) => {
      const tab = { id: `browser-${tabs.length + 1}`, url: url ?? 'about:blank', title: null };
      tabs.push(tab);
      return tab;
    }),
    navigate: vi.fn((id: string, url: string) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (!tab) throw new Error(`No browser tab of this task has the id ${id}.`);
      tab.url = url;
    }),
    close: vi.fn((id: string) => {
      tabs.splice(
        tabs.findIndex((tab) => tab.id === id),
        1
      );
    }),
    devServerOrigins: () => browsers.devOrigins,
    publicWebEnabled: async () => browsers.publicWeb,
  };
  const ports: ChatConductorPorts = {
    runTurn: async (messages) => {
      // The session keeps appending to its array: keep what this call was given.
      calls.push(structuredClone(messages));
      const next = replies.shift();
      if (!next) throw new Error('no reply scripted');
      if (next instanceof Error) throw next;
      return next;
    },
    readThread: async () => options.thread ?? null,
    saveThread: async (thread) => {
      saved.push(structuredClone(thread));
    },
    deleteThread: vi.fn(async () => {}),
    readLegacy: vi.fn(async (_adopted: readonly string[]): Promise<LegacyThread[]> => []),
    deleteLegacy: vi.fn(async (_ids: readonly string[]) => {}),
    agent,
    browsers,
    chatOnScreen: () => onScreen,
    ready: () => ready,
    defaultAutonomy: () => options.autonomy ?? true,
    now: () => new Date('2026-11-10T12:00:00Z'),
    newId: () => `id-${++id}`,
    warn: vi.fn(),
    eventGatherMs: 0,
    resolveDecision: vi.fn(
      (_holdId: string, _conversationId: string, _decision: ConductorDecision) => {}
    ),
    announceCompletions: () => announce.mode,
  };
  const session = new ChatConductorSession('task-1', ports);
  return {
    session,
    ports,
    agent,
    browsers,
    announce,
    resolved: () =>
      vi.mocked(ports.resolveDecision).mock.calls.map(([holdId, conversationId, decision]) => ({
        holdId,
        conversationId,
        decision,
      })),
    replies,
    calls,
    saved,
    received,
    setReady: (value: boolean) => (ready = value),
    setOnScreen: (chatId: string | null) => (onScreen = chatId),
    /** The first chat's agent changes state. */
    agentIs: (value: AgentSnapshot | null) => {
      snapshots.set('conv-1', value);
      onChange?.('conv-1', value);
    },
    chatIs: (chatId: string, value: AgentSnapshot | null) => {
      snapshots.set(chatId, value);
      onChange?.(chatId, value);
    },
    idle: async () => {
      await vi.waitFor(() => expect(session.busy).toBe(false));
      await session.flushed();
    },
    kinds: () => session.entries.map((entry) => entry.kind),
  };
}

/** A session that already follows its chat, with a thread that is not empty. */
async function following(options: { autonomy?: boolean } = {}) {
  const h = harness(options);
  h.replies.push(says(text('Caught up.')));
  await h.session.attach();
  await h.idle();
  h.calls.length = 0;
  return h;
}

function lastUserText(messages: Message[]): string {
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

/** Every tool_use is answered by a tool_result in the next message. */
function expectPaired(messages: Message[]): void {
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return;
    const uses = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    if (uses.length === 0) return;
    const next = messages[index + 1];
    const results =
      next && typeof next.content !== 'string'
        ? next.content.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
        : [];
    expect(results).toEqual(uses);
  });
}

describe('ChatConductorSession', () => {
  it('answers the developer, posts the reply and saves the thread', async () => {
    const h = harness();
    h.replies.push(says(text('It is at **step 2**.')));
    h.session.send('  Where is it?  ');
    await h.idle();

    expect(h.session.entries).toMatchObject([
      { kind: 'developer', text: 'Where is it?' },
      { kind: 'conductor', text: 'It is at **step 2**.' },
    ]);
    expect(lastUserText(h.calls[0]!)).toContain('<context>');
    expect(lastUserText(h.calls[0]!)).toContain('Where is it?');
    const last = h.saved.at(-1)!;
    expect(last.taskId).toBe('task-1');
    expect(last.entries).toHaveLength(2);
    expect(last.messages).toHaveLength(2);
  });

  it('catches the developer up on first attach, and only once', async () => {
    const h = harness();
    h.replies.push(says(text('The agent is waiting for you.')));
    await h.session.attach();
    await h.session.attach();
    await h.idle();

    expect(h.calls).toHaveLength(1);
    expect(lastUserText(h.calls[0]!)).toContain(CHAT_EVENT_MARK);
    expect(h.kinds()).toEqual(['event', 'conductor']);
    expect(h.agent.readOutput).toHaveBeenCalled();
  });

  it('does not run the first catch-up while chat conductors are not ready', async () => {
    const h = harness();
    h.setReady(false);
    await h.session.attach();
    await h.idle();
    expect(h.calls).toHaveLength(0);

    h.setReady(true);
    h.replies.push(says(text('Here is where it stands.')));
    await h.session.attach();
    await h.idle();
    expect(h.calls).toHaveLength(1);
  });

  it('spends no model call on the first catch-up of a chat with nothing to read', async () => {
    const h = harness();
    h.agent.readOutput.mockResolvedValue(' \n\n ');
    await h.session.attach();
    await h.idle();
    expect(h.calls).toHaveLength(0);
    expect(h.session.entries).toEqual([]);
    expect(h.saved.every((thread) => thread.entries.length === 0)).toBe(true);

    // Still nothing: one look per attach, no loop.
    await h.session.attach();
    await h.idle();
    expect(h.agent.readOutput).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(0);

    // Once there is output, the next attach catches the developer up.
    h.agent.readOutput.mockResolvedValue('raw output');
    h.replies.push(says(text('It has started.')));
    await h.session.attach();
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.kinds()).toEqual(['event', 'conductor']);
  });

  it('lets the first agent event or developer message run after an empty catch-up', async () => {
    const h = harness();
    h.agent.readOutput.mockResolvedValue('');
    await h.session.attach();
    await h.idle();

    h.replies.push(says(text('It finished the first step.')));
    h.agentIs(working);
    h.agentIs(finished('Step one done.'));
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.kinds()).toEqual(['event', 'conductor']);

    const other = harness();
    other.agent.readOutput.mockResolvedValue('');
    await other.session.attach();
    await other.idle();
    other.replies.push(says(text('Hello.')));
    other.session.send('Hi.');
    await other.idle();
    expect(other.kinds()).toEqual(['developer', 'conductor']);
  });

  it('says a failure that repeats on agent events once', async () => {
    const h = await following();
    const budget: ChatTurnResult = {
      success: false,
      error: { type: 'budget-exceeded', message: 'Budget used up.' },
    };
    const errors = () => h.session.entries.filter((entry) => entry.kind === 'error');
    let turn = 0;
    const eventTurn = async (reply: ChatTurnResult) => {
      h.replies.push(reply);
      h.agentIs(working);
      h.agentIs(finished(`Reply ${++turn}`));
      await h.idle();
    };
    await eventTurn(budget);
    const after = h.session.entries.length;
    await eventTurn(budget);
    await eventTurn(budget);
    expect(h.calls).toHaveLength(3);
    expect(errors()).toHaveLength(1);
    expect(h.session.entries).toHaveLength(after);

    // A different failure is news.
    await eventTurn({ success: false, error: { type: 'api-error', message: 'Network down.' } });
    expect(errors().map((entry) => entry.text)).toEqual(['Budget used up.', 'Network down.']);

    // A turn the developer started always shows its error.
    h.replies.push({ success: false, error: { type: 'api-error', message: 'Network down.' } });
    h.session.send('Anything new?');
    await h.idle();
    expect(errors()).toHaveLength(3);

    // And after the developer wrote, the same failure on an event is said again, once.
    await eventTurn({ success: false, error: { type: 'api-error', message: 'Network down.' } });
    await eventTurn({ success: false, error: { type: 'api-error', message: 'Network down.' } });
    expect(errors()).toHaveLength(3);
    h.replies.push(says(text('Back.')));
    h.session.send('Try again.');
    await h.idle();
    await eventTurn(budget);
    expect(errors()).toHaveLength(4);
  });

  it('posts nothing for an event the conductor has nothing to say about', async () => {
    const h = await following();
    const before = h.session.entries.length;
    h.replies.push(says(text(` ${CHAT_NOTHING_NEW}\n`)));
    h.agentIs(working);
    h.agentIs(finished('Ran the tests.'));
    await h.idle();

    expect(h.calls).toHaveLength(1);
    expect(lastUserText(h.calls[0]!)).toContain('Ran the tests.');
    expect(h.session.entries).toHaveLength(before);
    // The turn is still history, and its event is remembered.
    expect(h.saved.at(-1)!.chats['conv-1']?.lastEventKey).toMatch(/^finished:/);
  });

  it('marks an event in the thread once its turn has something to show', async () => {
    const h = await following();
    h.replies.push(says(text('Tests pass. Open http://localhost:3000.')));
    h.agentIs(working);
    h.agentIs(finished('Done.'));
    await h.idle();

    expect(h.session.entries.slice(-2)).toMatchObject([
      { kind: 'event', text: 'Zeus finished a turn' },
      { kind: 'conductor', text: 'Tests pass. Open http://localhost:3000.' },
    ]);
  });

  it('runs the tools the model calls and pairs every call with its result', async () => {
    const h = harness();
    h.replies.push(
      says(text('Checking.'), tool('read_chat', { lines: 400 }), tool('list_chats')),
      says(tool('send_to_agent', { message: 'Run the tests.' })),
      says(
        tool('update_notes', { notes: 'Goal: green tests.' }),
        tool('set_status', { state: 'working', headline: 'Running the tests' })
      ),
      says(text('I asked it to run the tests.'))
    );
    h.session.send('Get the tests green.');
    await h.idle();

    expect(h.calls).toHaveLength(4);
    expect(h.agent.readOutput).toHaveBeenCalledWith('conv-1', 400);
    // Typed into the agent under the conductor's mark; the thread shows it as the model wrote it.
    expect(h.agent.send).toHaveBeenCalledWith(
      'conv-1',
      markedForAgent('Run the tests.'),
      expect.any(Function)
    );
    expect(markedForAgent('Run the tests.')).toBe(`${CHAT_CONDUCTOR_MARK}\nRun the tests.`);
    expect(h.session.notes).toBe('Goal: green tests.');
    expect(h.session.status).toEqual({ state: 'working', headline: 'Running the tests' });
    expect(h.session.entries).toMatchObject([
      { kind: 'developer' },
      { kind: 'action', tool: 'send_to_agent', status: 'done', detail: 'Run the tests.' },
      { kind: 'conductor', text: 'I asked it to run the tests.' },
    ]);
    const stored = h.saved.at(-1)!;
    expectPaired(stored.messages);
    const readResult = JSON.stringify(h.calls[1]!.at(-1));
    expect(readResult).toContain('untrusted agent output');
    expect(readResult).toContain('raw output');
    expect(stored.notes).toBe('Goal: green tests.');
  });

  it('turns a tool failure, a bad input and an unknown tool into results, not a failed turn', async () => {
    const h = harness();
    h.agent.send.mockRejectedValueOnce(new Error('The agent did not accept input.'));
    h.replies.push(
      says(
        tool('send_to_agent', { message: 'Go.' }),
        tool('answer_prompt', { decision: 'maybe' }),
        tool('launch_rocket')
      ),
      says(text('The send failed.'))
    );
    h.session.send('Tell it to go.');
    await h.idle();

    const results = h.calls[1]!.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((result) => result.is_error)).toEqual([true, true, true]);
    expect(String(results[0]!.content)).toContain('did not accept input');
    expect(String(results[1]!.content)).toContain('Invalid input for answer_prompt');
    expect(String(results[2]!.content)).toContain('Unknown tool');
    expect(h.agent.answerPrompt).not.toHaveBeenCalled();
    expect(h.session.entries).toMatchObject([
      { kind: 'developer' },
      { kind: 'action', status: 'failed', detail: 'Go.' },
      { kind: 'conductor', text: 'The send failed.' },
    ]);
  });

  it('operates the session and the accounts for the developer', async () => {
    const h = harness();
    h.replies.push(
      says(tool('list_accounts')),
      says(
        tool('restart_agent', { claude_account: 'Work', prompt: 'Carry on with the tests.' }),
        tool('stop_agent')
      ),
      says(text('Moved it to Work.'))
    );
    h.session.send('Restart this agent on my other Claude account.');
    await h.idle();

    expect(h.agent.listAccounts).toHaveBeenCalledTimes(1);
    expect(h.agent.restart).toHaveBeenCalledWith(
      'conv-1',
      { claudeAccount: 'Work', prompt: markedForAgent('Carry on with the tests.') },
      expect.any(Function)
    );
    expect(h.agent.stop).toHaveBeenCalledTimes(1);
    expectPaired(h.calls.at(-1)!);
    // Reading the accounts leaves no row; what was done to the session does.
    expect(h.session.entries.filter((entry) => entry.kind === 'action')).toMatchObject([
      {
        tool: 'restart_agent',
        status: 'done',
        summary: 'Restarted Zeus on the Claude account "Work"',
        detail: 'Carry on with the tests.',
      },
      { tool: 'stop_agent', status: 'done', summary: "Stopped Zeus's session" },
    ]);

    // A plain restart, a failure, and a prompt that did not arrive afterwards.
    h.agent.restart.mockImplementationOnce(async (_chatId, _input, onLateFailure) => {
      onLateFailure('The restarted agent did not take the prompt.');
      throw new Error('The session did not start.');
    });
    h.replies.push(says(tool('restart_agent')), says(text('It would not start.')));
    h.session.send('Restart it.');
    await h.idle();
    expect(h.agent.restart).toHaveBeenLastCalledWith('conv-1', {}, expect.any(Function));
    expect(h.session.entries.slice(-3)).toMatchObject([
      { kind: 'error', text: 'The restarted agent did not take the prompt.' },
      {
        kind: 'action',
        tool: 'restart_agent',
        status: 'failed',
        summary: "Could not restart Zeus's session: The session did not start.",
      },
      { kind: 'conductor', text: 'It would not start.' },
    ]);
  });

  it('does not restart or stop the session on an event while autonomy is off', async () => {
    const h = await following({ autonomy: false });
    h.replies.push(
      says(
        tool('restart_agent', { claude_account: 'Work' }),
        tool('stop_agent'),
        tool('list_accounts')
      ),
      says(text('I would move it to Work.'))
    );
    h.agentIs(working);
    h.agentIs(finished('Usage limit reached.'));
    await h.idle();
    expect(h.agent.restart).not.toHaveBeenCalled();
    expect(h.agent.stop).not.toHaveBeenCalled();
    expect(h.agent.listAccounts).toHaveBeenCalledTimes(1);
    expect(
      h.session.entries.flatMap((entry) => (entry.kind === 'action' ? [entry.status] : []))
    ).toEqual(['refused', 'refused']);
  });

  it('refuses acting tools on an event turn while autonomy is off', async () => {
    const h = await following({ autonomy: false });
    h.replies.push(
      says(tool('send_to_agent', { message: 'Continue.' }), tool('read_chat')),
      says(text('It finished. I would tell it to continue.'))
    );
    h.agentIs(working);
    h.agentIs(finished('Step one done.'));
    await h.idle();

    expect(h.agent.send).not.toHaveBeenCalled();
    expect(h.agent.readOutput).toHaveBeenCalledWith('conv-1', 80);
    const results = h.calls[1]!.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String(results[0]!.content)).toContain('autonomy is off');
    expect(h.session.entries.slice(-3)).toMatchObject([
      { kind: 'event' },
      { kind: 'action', status: 'refused', detail: 'Continue.' },
      { kind: 'conductor' },
    ]);
  });

  it('lets a turn the developer started act with autonomy off', async () => {
    const h = await following({ autonomy: false });
    h.replies.push(says(tool('interrupt_agent')), says(text('Stopped it.')));
    h.session.send('Stop it.');
    await h.idle();
    expect(h.agent.interrupt).toHaveBeenCalledTimes(1);
  });

  it('stops acting on its own at the cap until the developer writes again', async () => {
    const h = await following();
    let turn = 0;
    const eventTurn = async (reply: ChatTurnResult[]) => {
      h.replies.push(...reply);
      h.agentIs(working);
      h.agentIs(finished(`Reply ${++turn}`));
      await h.idle();
    };
    for (let count = 0; count < MAX_UNATTENDED_ACTIONS; count++) {
      await eventTurn([says(tool('send_to_agent', { message: 'Next.' })), says(text('On it.'))]);
    }
    expect(h.agent.send).toHaveBeenCalledTimes(MAX_UNATTENDED_ACTIONS);
    expect(h.session.unattendedActionsLeft).toBe(0);

    await eventTurn([says(tool('send_to_agent', { message: 'Next.' })), says(text('Your call.'))]);
    expect(h.agent.send).toHaveBeenCalledTimes(MAX_UNATTENDED_ACTIONS);
    expect(h.session.entries.at(-2)).toMatchObject({ kind: 'action', status: 'refused' });
    expect(lastUserText(h.calls.at(-2)!)).toContain('used up');

    h.replies.push(says(text('Carrying on.')));
    h.session.send('Keep going.');
    await h.idle();
    expect(h.session.unattendedActionsLeft).toBe(MAX_UNATTENDED_ACTIONS);

    await eventTurn([says(tool('send_to_agent', { message: 'Next.' })), says(text('Sent.'))]);
    expect(h.agent.send).toHaveBeenCalledTimes(MAX_UNATTENDED_ACTIONS + 1);
  });

  it('handles an agent event once', async () => {
    const h = await following();
    const done = finished('All done.');
    h.replies.push(says(text('It is done.')));
    h.agentIs(working);
    h.agentIs(done);
    await h.idle();
    expect(h.calls).toHaveLength(1);

    // The same state again: a re-render, or the verdict that the turn needs the developer.
    h.agentIs(done);
    h.agentIs({ ...done, status: 'awaiting-input', notification: 'idle_prompt' });
    await h.idle();
    expect(h.calls).toHaveLength(1);

    // The same reply after the agent worked again is a new turn.
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs(done);
    await h.idle();
    expect(h.calls).toHaveLength(2);
  });

  it('does not repeat an event its saved thread already handled', async () => {
    const first = await following();
    first.replies.push(says(text('It is done.')));
    first.agentIs(working);
    first.agentIs(finished('All done.'));
    await first.idle();
    const thread = first.saved.at(-1)!;

    const again = harness({ thread });
    again.agentIs(finished('All done.'));
    await again.session.attach();
    await again.idle();
    expect(again.calls).toHaveLength(0);
    expect(again.session.entries).toHaveLength(thread.entries.length);

    // A different ending found on restart is news.
    const later = harness({ thread });
    later.agentIs(finished('Something else.'));
    later.replies.push(says(text('It moved on.')));
    await later.session.attach();
    await later.idle();
    expect(later.calls).toHaveLength(1);
  });

  it('runs no turn for a status restored without its reply or prompt', async () => {
    const first = await following();
    first.replies.push(says(text('It is done.')));
    first.agentIs(working);
    first.agentIs(finished('All done.'));
    await first.idle();
    const handled = first.saved.at(-1)!;
    const bare: AgentSnapshot = { status: 'completed', report: null, notification: null };

    // App start: the stored status is back, its reply is not.
    const restarted = harness({ thread: handled });
    restarted.agentIs(bare);
    await restarted.session.attach();
    await restarted.idle();
    expect(restarted.calls).toHaveLength(0);
    expect(restarted.agent.finishedReport).not.toHaveBeenCalled();

    // The same when the saved thread never ran a turn for an event, whatever the stored status.
    const rest = { ...handled, chats: {} };
    for (const status of ['completed', 'awaiting-input', 'error'] as const) {
      const unseen = harness({ thread: rest });
      unseen.agentIs({ status, report: null, notification: null });
      await unseen.session.attach();
      await unseen.idle();
      expect(unseen.calls).toHaveLength(0);
    }

    // The chat loads after the conductor attached, or its task is loaded again mid-run.
    const late = harness({ thread: rest });
    late.agentIs(null);
    await late.session.attach();
    late.agentIs(bare);
    await late.idle();
    expect(late.calls).toHaveLength(0);
    first.agentIs(null);
    first.agentIs(bare);
    await first.idle();
    expect(first.calls).toHaveLength(1);

    // What the agent does from there on is news again.
    restarted.replies.push(says(text('Done again.')));
    restarted.agentIs(working);
    restarted.agentIs(bare);
    await restarted.idle();
    expect(restarted.calls).toHaveLength(1);
  });

  it('ignores agent events until attached, and while not ready', async () => {
    const h = harness();
    await h.session.load();
    h.agentIs(finished('Done.'));
    await h.idle();
    expect(h.calls).toHaveLength(0);

    const followed = await following();
    followed.setReady(false);
    followed.agentIs(working);
    followed.agentIs(finished('Done.'));
    await followed.idle();
    expect(followed.calls).toHaveLength(0);
  });

  it('reads the terminal when a finished agent reported no reply', async () => {
    const h = await following();
    h.agent.finishedReport.mockResolvedValueOnce({
      text: 'tail of the terminal',
      truncated: false,
      appUrls: [],
      source: 'terminal-tail',
    } as never);
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs({ status: 'completed', report: null, notification: null });
    await h.idle();
    expect(lastUserText(h.calls[0]!)).toContain('tail of the terminal');
  });

  it('leaves valid history and an error entry when the first model call fails', async () => {
    const h = harness();
    h.replies.push({
      success: false,
      error: { type: 'budget-exceeded', message: "Today's conductor budget is used up." },
    });
    h.session.send('Where is it?');
    await h.idle();

    expect(h.session.entries).toMatchObject([
      { kind: 'developer' },
      { kind: 'error', text: "Today's conductor budget is used up." },
    ]);
    expect(h.saved.at(-1)!.messages).toEqual([]);

    h.replies.push(says(text('Back.')));
    h.session.send('And now?');
    await h.idle();
    expect(h.calls[1]).toHaveLength(1);
    expect(h.saved.at(-1)!.messages).toHaveLength(2);
  });

  it('does not run a failed event turn again', async () => {
    const h = await following();
    h.replies.push({ success: false, error: { type: 'budget-exceeded', message: 'Budget.' } });
    const done = finished('Done.');
    h.agentIs(working);
    h.agentIs(done);
    await h.idle();
    h.agentIs(done);
    await h.idle();
    expect(h.calls).toHaveLength(1);
    expect(h.session.entries.at(-1)).toMatchObject({ kind: 'error', text: 'Budget.' });
  });

  it('keeps tool calls paired when a later model call fails', async () => {
    const h = harness();
    h.replies.push(says(tool('send_to_agent', { message: 'Go.' })), new Error('network down'));
    h.session.send('Tell it to go.');
    await h.idle();

    const stored = h.saved.at(-1)!;
    expect(stored.messages).toHaveLength(3);
    expectPaired(stored.messages);
    expect(h.session.entries.at(-1)).toMatchObject({ kind: 'error', text: 'network down' });

    // The next turn follows the stored tool results: a user message after a user message, which
    // the API reads as one turn, with every call still answered.
    h.replies.push(says(text('It went.')));
    h.session.send('Did it go?');
    await h.idle();
    const next = h.calls.at(-1)!;
    expect(next.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expectPaired(next);
    expect(h.saved.at(-1)!.messages.at(-1)?.role).toBe('assistant');
  });

  it('coalesces queued agent events and keeps every developer message', async () => {
    const h = await following();
    const gate = deferred<ChatTurnResult>();
    h.replies.push(gate.promise);
    h.session.send('First.');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));

    h.agentIs(working);
    h.agentIs(finished('Reply A'));
    h.session.send('Second.');
    h.agentIs(working);
    h.agentIs(finished('Reply B'));
    h.session.send('Third.');
    h.replies.push(says(text('Two.')), says(text('Three.')), says(text('B noted.')));
    gate.resolve(says(text('One.')));
    await h.idle();

    expect(h.calls).toHaveLength(4);
    expect(lastUserText(h.calls[1]!)).toContain('Second.');
    expect(lastUserText(h.calls[2]!)).toContain('Third.');
    expect(lastUserText(h.calls[3]!)).toContain('Reply B');
    expect(h.calls.some((messages) => lastUserText(messages).includes('Reply A'))).toBe(false);
    expect(
      h.session.entries.filter((entry) => entry.kind === 'developer').map((entry) => entry.text)
    ).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('ends a turn that never settles at the round cap', async () => {
    const h = harness();
    for (let round = 0; round < MAX_TURN_ROUNDS + 2; round++) {
      h.replies.push(says(text(`Round ${round}`), tool('read_chat')));
    }
    h.session.send('Look into it.');
    await h.idle();

    expect(h.calls).toHaveLength(MAX_TURN_ROUNDS);
    expect(h.session.entries.slice(-2)).toMatchObject([
      { kind: 'conductor', text: `Round ${MAX_TURN_ROUNDS - 1}` },
      { kind: 'error' },
    ]);
    expectPaired(h.saved.at(-1)!.messages);
  });

  it('stops between steps and still answers the tool calls already made', async () => {
    const h = harness();
    const gate = deferred<ChatTurnResult>();
    h.replies.push(gate.promise);
    h.session.send('Do a lot.');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.session.stop();
    gate.resolve(says(tool('send_to_agent', { message: 'Go.' })));
    await h.idle();

    expect(h.agent.send).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(h.session.entries.at(-1)).toMatchObject({ kind: 'event', text: 'Stopped' });
    expectPaired(h.saved.at(-1)!.messages);
  });

  it('asks for a catch-up as the developer once the thread has history', async () => {
    const h = await following();
    h.replies.push(says(text('Nothing waits on you.')));
    h.session.catchUp();
    await h.idle();
    expect(h.session.entries.slice(-2)).toMatchObject([
      { kind: 'developer', text: CATCH_UP_REQUEST },
      { kind: 'conductor' },
    ]);
  });

  it('clears the thread on reset and stays quiet afterwards', async () => {
    const h = await following();
    h.session.setAutonomy(false);
    await h.session.reset();

    expect(h.ports.deleteThread).toHaveBeenCalledTimes(1);
    expect(h.session.entries).toEqual([]);
    expect(h.session.autonomy).toBe(false);
    await h.session.attach();
    await h.idle();
    expect(h.calls).toHaveLength(0);
  });

  it('keeps what the developer wrote while the saved thread was loading', async () => {
    const first = harness();
    first.replies.push(says(text('Hello.')));
    first.session.send('Hi.');
    await first.idle();

    const h = harness({ thread: first.saved.at(-1)! });
    h.replies.push(says(text('Still here.')));
    h.session.send('Are you there?');
    await h.idle();
    expect(h.kinds()).toEqual(['developer', 'conductor', 'developer', 'conductor']);
    expect(h.calls[0]).toHaveLength(3);
  });
});

describe("the developer's own words to the agent, and the conductor's", () => {
  it('shows an event turn what the developer typed into the agent since the last one', async () => {
    const h = await following();
    h.received.push({ text: 'Publish this, go with your recommendations', by: 'developer' });
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs(finished('Publishing batch 2 of 3.'));
    await h.idle();

    const turn = lastUserText(h.calls[0]!);
    expect(turn).toContain('<prompts-to-agent chat="Zeus">');
    expect(turn).toContain(
      'typed by the developer into the agent themselves:\n  Publish this, go with your recommendations'
    );
    // Read once: the next event does not show it again.
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs(finished('Batch 3 of 3 published.'));
    await h.idle();
    expect(lastUserText(h.calls[1]!)).not.toContain('<prompts-to-agent');
    expect(h.agent.receivedPrompts).toHaveBeenCalledTimes(3);
    // Each read starts where the last one left off, and the cursor is saved with the thread.
    expect(h.agent.receivedPrompts.mock.calls.at(-1)).toEqual(['conv-1', 2]);
    expect(h.saved.at(-1)?.chats['conv-1']?.promptCursor).toBe(3);
  });

  it('marks what it types and remembers it, so it never reads its own prompt as the developer', async () => {
    const h = await following();
    h.replies.push(
      says(tool('send_to_agent', { message: 'Run the release checks first.' })),
      says(text('Asked it to run the checks.'))
    );
    h.session.send('Have it run the release checks.');
    await h.idle();

    expect(h.agent.send).toHaveBeenCalledWith(
      'conv-1',
      markedForAgent('Run the release checks first.'),
      expect.any(Function)
    );
    // The thread shows the message as the conductor wrote it, without the mark.
    const action = h.session.entries.find((entry) => entry.kind === 'action');
    expect(action).toMatchObject({ detail: 'Run the release checks first.' });
    expect(JSON.stringify(h.session.entries)).not.toContain(CHAT_CONDUCTOR_MARK);
    expect(h.saved.at(-1)?.chats['conv-1']?.sentToAgent).toEqual(['Run the release checks first.']);

    // A chat agent's transcript holds the conductor's prompt as received, mark and all.
    h.received.push(
      { text: markedForAgent('Run the release checks first.'), by: 'relayed' },
      { text: 'Run the release checks first.', by: 'relayed' },
      { text: 'Skip the changelog', by: 'relayed' }
    );
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs(finished('Checks pass.'));
    await h.idle();
    const turn = lastUserText(h.calls.at(-1)!);
    expect(turn).toContain('Skip the changelog');
    expect(turn).not.toContain('Run the release checks first.');
  });

  it("starts a chat inside the task with a marked brief, on the last chat's provider", async () => {
    const h = await following();
    h.replies.push(
      says(tool('start_chat', { name: 'Docs', prompt: 'Write the release notes.' })),
      says(text('Started a docs chat.'))
    );
    h.session.send('Start an agent for the release notes.');
    await h.idle();
    expect(h.agent.startChat).toHaveBeenCalledWith(
      { name: 'Docs', provider: 'claude', prompt: markedForAgent('Write the release notes.') },
      expect.any(Function)
    );
    // Its brief is the conductor's own prompt to that chat, and that chat is the one it last dealt
    // with now.
    const thread = h.saved.at(-1)!;
    expect(thread.chats['conv-2']?.sentToAgent).toEqual(['Write the release notes.']);
    expect(thread.lastChatId).toBe('conv-2');
    expect(h.session.entries.find((entry) => entry.kind === 'action')).toMatchObject({
      summary: 'Started a new chat: Docs',
      detail: 'Write the release notes.',
    });
  });

  it('says so when what the agent received could not be read', async () => {
    const h = await following();
    h.agent.receivedPrompts.mockRejectedValueOnce(new Error('This chat is not loaded.'));
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.agentIs(working);
    h.agentIs(finished('Done.'));
    await h.idle();
    expect(lastUserText(h.calls.at(-1)!)).toContain('could not be read (This chat is not loaded.)');
  });
});

describe('one conductor over the chats of a task', () => {
  const twoChats: Chat[] = [
    { id: 'conv-1', name: 'Zeus', providerId: 'claude' },
    { id: 'conv-2', name: 'Hera', providerId: 'codex' },
  ];

  async function task(options: { chats?: Chat[] } = {}) {
    const h = harness({ chats: options.chats ?? twoChats.map((chat) => ({ ...chat })) });
    h.replies.push(says(text('Caught up.')));
    await h.session.attach();
    await h.idle();
    h.calls.length = 0;
    return h;
  }

  it('acts on the chat a tool names, any case, and on the chat on screen without a name', async () => {
    const h = await task();
    h.replies.push(
      says(
        tool('send_to_agent', { chat: 'hera', message: 'Review the diff.' }),
        tool('interrupt_agent')
      ),
      says(text('Done.'))
    );
    h.session.send('Have Hera review it and stop Zeus.');
    await h.idle();
    expect(h.agent.send).toHaveBeenCalledWith(
      'conv-2',
      markedForAgent('Review the diff.'),
      expect.any(Function)
    );
    expect(h.agent.interrupt).toHaveBeenCalledWith('conv-1');
    expect(h.session.entries.filter((entry) => entry.kind === 'action')).toMatchObject([
      { summary: 'Sent Hera a prompt', detail: 'Review the diff.' },
      { summary: 'Interrupted Zeus' },
    ]);
  });

  it('refuses an unknown name, or no name with nothing on screen, listing the chats', async () => {
    const h = await task();
    h.setOnScreen(null);
    h.replies.push(
      says(tool('send_to_agent', { chat: 'Apollo', message: 'Go.' }), tool('interrupt_agent')),
      says(text('Which chat?'))
    );
    h.session.send('Tell it to go.');
    await h.idle();
    expect(h.agent.send).not.toHaveBeenCalled();
    expect(h.agent.interrupt).not.toHaveBeenCalled();
    const results = JSON.stringify(h.calls.at(-1)!.at(-1));
    expect(results).toContain('No chat in this task is called \\"Apollo\\"');
    expect(results).toContain('Say which chat');
    expect(results).toContain('\\"Zeus\\" (Claude), \\"Hera\\" (Codex)');
    // No action rows for what was never attempted.
    expect(h.session.entries.some((entry) => entry.kind === 'action')).toBe(false);
  });

  it('refuses a name two chats share rather than guess', async () => {
    const h = await task({
      chats: [
        { id: 'conv-1', name: 'Zeus', providerId: 'claude' },
        { id: 'conv-2', name: 'zeus', providerId: 'codex' },
      ],
    });
    h.replies.push(
      says(tool('send_to_agent', { chat: 'ZEUS', message: 'Go.' })),
      says(text('Which one?'))
    );
    h.session.send('Tell Zeus to go.');
    await h.idle();
    expect(h.agent.send).not.toHaveBeenCalled();
    expect(JSON.stringify(h.calls.at(-1)!.at(-1))).toContain('Several chats are called');
  });

  it('takes chats that report close together into one turn, each named', async () => {
    const h = await task();
    h.replies.push(says(text('Both are done.')));
    // A turn is running: both events wait for it and then share the next one.
    let release: (value: ChatTurnResult) => void = () => {};
    h.replies.unshift(new Promise<ChatTurnResult>((resolve) => (release = resolve)));
    h.replies.push(says(text('Unused.')));
    h.session.send('How is it going?');
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    h.chatIs('conv-1', working);
    h.chatIs('conv-1', finished('Zeus is done.'));
    h.chatIs('conv-2', working);
    h.chatIs('conv-2', finished('Hera is done.'));
    release(says(text('Going well.')));
    await h.idle();

    expect(h.calls).toHaveLength(2);
    const turn = lastUserText(h.calls[1]!);
    expect(turn).toContain("2 of the task's chats have news.");
    expect(turn).toContain('<agent-output kind="final-reply" chat="Zeus">\nZeus is done.');
    expect(turn).toContain('<agent-output kind="final-reply" chat="Hera">\nHera is done.');
    expect([...h.session.entries].reverse().find((entry) => entry.kind === 'event')).toMatchObject({
      text: 'Zeus finished a turn; Hera finished a turn',
    });
    // Each chat keeps its own event, so neither is news again.
    const saved = h.saved.at(-1)!;
    expect(saved.chats['conv-1']?.lastEventKey).toMatch(/^finished:/);
    expect(saved.chats['conv-2']?.lastEventKey).toMatch(/^finished:/);
    expect(saved.chats['conv-1']?.lastEventKey).not.toBe(saved.chats['conv-2']?.lastEventKey);
  });

  it('raises no event for a chat it just started until that chat has news', async () => {
    const h = await task({ chats: [{ id: 'conv-1', name: 'Zeus', providerId: 'claude' }] });
    h.replies.push(
      says(tool('start_chat', { prompt: 'Review the diff.' })),
      says(text('Started.'))
    );
    h.session.send('Get a second opinion from Codex.');
    await h.idle();
    // The new chat appears, working on its brief: not news.
    h.chatIs('conv-2', { status: 'working', report: null, notification: null });
    h.chatIs('conv-2', { status: 'idle', report: null, notification: null });
    await h.idle();
    expect(h.calls).toHaveLength(2);

    h.replies.push(says(text('Hera found two issues.')));
    h.chatIs('conv-2', finished('Two issues.'));
    await h.idle();
    expect(h.calls).toHaveLength(3);
    expect(lastUserText(h.calls[2]!)).toContain('News from the chat "Hera".');
  });

  it('starts a chat on the provider of the chat it last dealt with', async () => {
    const h = await task();
    h.replies.push(
      says(tool('read_chat', { chat: 'Hera' })),
      says(tool('start_chat', { prompt: 'Another reviewer.' })),
      says(text('Started.'))
    );
    h.session.send('Read Hera, then start another reviewer.');
    await h.idle();
    expect(h.agent.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      expect.any(Function)
    );
  });

  it("adopts the chats' own threads when it loads, and removes them once saved", async () => {
    const h = harness({ chats: twoChats.map((chat) => ({ ...chat })) });
    const legacy = {
      version: 1 as const,
      conversationId: 'conv-2',
      entries: [
        { kind: 'conductor' as const, id: 'old', at: '2026-11-01T10:00:00.000Z', text: 'Earlier.' },
      ],
      messages: [],
      notes: 'Hera reviews.',
      status: null,
      autonomy: true,
      lastEventKey: 'finished:abc',
      updatedAt: '2026-11-01T10:00:00.000Z',
    };
    vi.mocked(h.ports.readLegacy).mockResolvedValueOnce([{ thread: legacy, name: 'Hera' }]);
    await h.session.load();
    expect(h.session.entries).toMatchObject([{ id: 'old', text: 'Earlier.' }]);
    expect(h.session.notes).toBe('From the chat "Hera":\nHera reviews.');
    expect(h.ports.readLegacy).toHaveBeenCalledWith([]);
    expect(h.ports.deleteLegacy).toHaveBeenCalledWith(['conv-2']);
    const saved = h.saved.at(-1)!;
    expect(saved.adopted).toEqual(['conv-2']);
    expect(saved.chats['conv-2']?.lastEventKey).toBe('finished:abc');

    // A chat that loads later is taken in too; one already adopted is not asked for again.
    vi.mocked(h.ports.readLegacy).mockResolvedValueOnce([]);
    await h.session.adoptLoadedChats();
    expect(h.ports.readLegacy).toHaveBeenLastCalledWith(['conv-2']);
  });

  it('keeps each chat’s typed prompts apart and names whose they are', async () => {
    const h = await task();
    vi.mocked(h.agent.receivedPrompts).mockImplementation(async (chatId) => ({
      prompts:
        chatId === 'conv-2' ? [{ text: 'Ship the review today', by: 'developer' as const }] : [],
      cursor: 1,
    }));
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.chatIs('conv-2', working);
    h.chatIs('conv-2', finished('Reviewed.'));
    await h.idle();
    const turn = lastUserText(h.calls.at(-1)!);
    expect(turn).toContain('<prompts-to-agent chat="Hera">');
    expect(turn).toContain('Ship the review today');
    expect(h.agent.receivedPrompts).toHaveBeenLastCalledWith('conv-2', expect.any(Number));
  });
});

describe("the task's browser tabs", () => {
  it('opens, lists, navigates and closes tabs the developer asked for, showing the URL', async () => {
    const h = await following();
    h.replies.push(
      says(tool('open_browser', { url: 'http://localhost:5173/login' })),
      says(tool('list_browsers')),
      says(tool('navigate_browser', { id: 'browser-1', url: 'localhost:5173/signup' })),
      says(tool('close_browser', { id: 'browser-1' })),
      says(text('Done.'))
    );
    h.session.send('Open the login page, then the signup page, then close it.');
    await h.idle();

    expect(h.browsers.open).toHaveBeenCalledWith('http://localhost:5173/login');
    expect(h.browsers.navigate).toHaveBeenCalledWith('browser-1', 'http://localhost:5173/signup');
    expect(h.browsers.close).toHaveBeenCalledWith('browser-1');
    expect(h.session.entries.filter((entry) => entry.kind === 'action')).toMatchObject([
      {
        tool: 'open_browser',
        summary: 'Opened a browser at http://localhost:5173/login',
        detail: 'http://localhost:5173/login',
      },
      { tool: 'navigate_browser', detail: 'localhost:5173/signup' },
      { tool: 'close_browser', status: 'done' },
    ]);
    const listed = JSON.stringify(h.calls[2]!.at(-1));
    expect(listed).toContain('id browser-1: http://localhost:5173/login');
  });

  it('opens a public site only when the developer named it and the setting is on', async () => {
    const h = await following();
    h.browsers.publicWeb = true;
    h.replies.push(
      says(tool('open_browser', { url: 'https://docs.stripe.com/api' })),
      says(tool('open_browser', { url: 'https://phish.example/login' })),
      says(text('Opened the docs.'))
    );
    h.session.send('Open docs.stripe.com so I can read the API.');
    await h.idle();
    expect(h.browsers.open).toHaveBeenCalledTimes(1);
    expect(h.browsers.open).toHaveBeenCalledWith('https://docs.stripe.com/api');
    expect(h.session.entries.filter((entry) => entry.kind === 'action')).toMatchObject([
      { status: 'done' },
      { status: 'failed', summary: expect.stringContaining("developer's own message names it") },
    ]);
  });

  it('opens nothing but the dev servers on a chat event, and only with autonomy', async () => {
    const h = await following();
    h.browsers.publicWeb = true;
    h.replies.push(
      says(
        tool('open_browser', { url: 'https://docs.stripe.com' }),
        tool('open_browser', { url: 'http://localhost:5173' })
      ),
      says(text(CHAT_NOTHING_NEW))
    );
    h.agentIs(working);
    h.agentIs(finished('See https://docs.stripe.com and http://localhost:5173.'));
    await h.idle();
    expect(h.browsers.open).toHaveBeenCalledTimes(1);
    expect(h.browsers.open).toHaveBeenCalledWith('http://localhost:5173/');

    const off = await following({ autonomy: false });
    off.replies.push(
      says(tool('open_browser', { url: 'http://localhost:5173' })),
      says(text(CHAT_NOTHING_NEW))
    );
    off.agentIs(working);
    off.agentIs(finished('The app is up.'));
    await off.idle();
    expect(off.browsers.open).not.toHaveBeenCalled();
    expect(off.session.entries.at(-1)).toMatchObject({ kind: 'action', status: 'refused' });
  });
});

describe('deciding what the developer is told', () => {
  const FAR = new Date('2026-11-10T12:00:00Z').getTime() + 60_000;
  const held = (
    overrides: Partial<{
      holdId: string;
      conversationId: string;
      kind: 'finished' | 'awaiting-input';
      notificationType: 'permission_prompt' | 'idle_prompt';
      text: string | null;
      decideBy: number;
    }> = {}
  ) => {
    const text = overrides.text === undefined ? 'Published batch 2 of 3.' : overrides.text;
    return {
      holdId: overrides.holdId ?? 'hold-1',
      conversationId: overrides.conversationId ?? 'conv-1',
      kind: overrides.kind ?? 'finished',
      ...(overrides.notificationType ? { notificationType: overrides.notificationType } : {}),
      completionReport: text === null ? null : { text, truncated: false, appUrls: [] },
      decideBy: overrides.decideBy ?? FAR,
    };
  };

  it('shows needs_you with its headline, notifying by default', async () => {
    const h = await following();
    h.replies.push(
      says(tool('set_status', { state: 'needs_you', headline: 'Zeus wants a release name' })),
      says(text('Zeus needs a name for the release.'))
    );
    expect(h.session.decide(held())).toBe(true);
    await h.idle();
    expect(lastUserText(h.calls[0]!)).toContain('Published batch 2 of 3.');
    expect(h.resolved()).toEqual([
      {
        holdId: 'hold-1',
        conversationId: 'conv-1',
        decision: {
          kind: 'surface',
          state: 'needs_you',
          headline: 'Zeus wants a release name',
          notify: true,
        },
      },
    ]);
  });

  it('notifies done only when every finished agent is announced, unless told otherwise', async () => {
    const h = await following();
    h.announce.mode = 'attention_only';
    h.replies.push(
      says(tool('set_status', { state: 'done', headline: 'Release published' })),
      says(text('Done.'))
    );
    h.session.decide(held());
    await h.idle();
    expect(h.resolved()[0]?.decision).toMatchObject({
      kind: 'surface',
      state: 'done',
      notify: false,
    });

    h.replies.push(
      says(
        tool('set_status', {
          state: 'done',
          headline: 'Release published',
          detail: 'All three batches are live.',
          notify: true,
        })
      ),
      says(text('Done.'))
    );
    h.session.decide(held({ holdId: 'hold-2', text: 'Published batch 3 of 3.' }));
    await h.idle();
    expect(h.resolved()[1]?.decision).toEqual({
      kind: 'surface',
      state: 'done',
      headline: 'Release published',
      detail: 'All three batches are live.',
      notify: true,
    });
  });

  it('keeps quiet on nothing new, no status, or a working status', async () => {
    const h = await following();
    h.replies.push(says(text(CHAT_NOTHING_NEW)));
    h.session.decide(held());
    await h.idle();
    h.replies.push(
      says(tool('set_status', { state: 'working', headline: 'Batch 3 is publishing' })),
      says(text('It goes on.'))
    );
    h.session.decide(held({ holdId: 'hold-2', text: 'Batch 2 done, starting 3.' }));
    await h.idle();
    expect(h.resolved().map((call) => call.decision)).toEqual([
      { kind: 'quiet' },
      { kind: 'quiet' },
    ]);
  });

  it('says a prompt was answered when it answered it this turn', async () => {
    const h = await following();
    h.replies.push(says(tool('answer_prompt', { decision: 'allow' })), says(text('Allowed it.')));
    h.session.decide(
      held({ kind: 'awaiting-input', notificationType: 'permission_prompt', text: null })
    );
    await h.idle();
    expect(h.agent.answerPrompt).toHaveBeenCalledWith('conv-1', 'allow');
    expect(h.resolved()[0]?.decision).toEqual({ kind: 'quiet', answered: true });
  });

  it('falls back on every way a turn can fail', async () => {
    const h = await following();
    h.replies.push(new Error('network down'));
    h.session.decide(held({ holdId: 'model' }));
    await h.idle();

    h.replies.push({
      success: false,
      error: { type: 'budget-exceeded', message: 'Budget used up.' },
    });
    h.session.decide(held({ holdId: 'budget', text: 'Another reply.' }));
    await h.idle();

    for (let round = 0; round < MAX_TURN_ROUNDS; round++) h.replies.push(says(tool('list_chats')));
    h.session.decide(held({ holdId: 'rounds', text: 'A third reply.' }));
    await h.idle();

    h.session.decide(held({ holdId: 'late', text: 'A fourth reply.', decideBy: 0 }));
    await h.idle();

    const pending = deferred<ChatTurnResult>();
    h.replies.push(pending.promise);
    h.session.decide(held({ holdId: 'stopped', text: 'A fifth reply.' }));
    await vi.waitFor(() => expect(h.session.busy).toBe(true));
    h.session.stop();
    pending.resolve(says(tool('list_chats')));
    await h.idle();

    const fellBack = h.resolved().filter((call) => call.decision.kind === 'fallback');
    expect(fellBack.map((call) => call.holdId)).toEqual([
      'model',
      'budget',
      'rounds',
      'late',
      'stopped',
    ]);
  });

  it('falls back for a turn cut off by a reset, and for holds still waiting at dispose', async () => {
    const h = await following();
    const pending = deferred<ChatTurnResult>();
    h.replies.push(pending.promise);
    h.session.decide(held({ holdId: 'running' }));
    await vi.waitFor(() => expect(h.session.busy).toBe(true));
    h.session.decide(held({ holdId: 'waiting', conversationId: 'conv-1', text: 'Newer reply.' }));
    await h.session.reset();
    pending.resolve(says(text('Late.')));
    await h.idle();
    expect(h.resolved().map((call) => [call.holdId, call.decision.kind])).toEqual([
      ['waiting', 'fallback'],
      ['running', 'fallback'],
    ]);

    const other = await following();
    const blocked = deferred<ChatTurnResult>();
    other.replies.push(blocked.promise);
    other.session.send('Busy.');
    await vi.waitFor(() => expect(other.session.busy).toBe(true));
    other.session.decide(held({ holdId: 'at-dispose' }));
    other.session.dispose();
    blocked.resolve(says(text('Done.')));
    expect(other.resolved()).toEqual([
      {
        holdId: 'at-dispose',
        conversationId: 'conv-1',
        decision: { kind: 'fallback', reason: 'the conductor closed' },
      },
    ]);
  });

  it('refuses what it cannot take, and drops a hold main closed before its turn', async () => {
    const h = harness();
    expect(h.session.decide(held())).toBe(false);
    const f = await following();
    expect(f.session.decide(held({ conversationId: 'conv-x' }))).toBe(false);
    f.setReady(false);
    expect(f.session.decide(held())).toBe(false);
    f.setReady(true);

    const blocked = deferred<ChatTurnResult>();
    f.replies.push(blocked.promise, says(text('Hi.')));
    f.session.send('Hello.');
    await vi.waitFor(() => expect(f.session.busy).toBe(true));
    f.session.decide(held({ holdId: 'closed' }));
    f.session.decisionClosed('closed');
    blocked.resolve(says(text('Hello.')));
    await f.idle();
    expect(f.resolved()).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it('goes before waiting developer messages, and runs no second turn for what main publishes', async () => {
    const h = await following();
    const blocked = deferred<ChatTurnResult>();
    h.replies.push(blocked.promise);
    h.session.send('First.');
    await vi.waitFor(() => expect(h.session.busy).toBe(true));
    h.session.send('Second.');
    h.session.decide(held());
    h.replies.push(says(text(CHAT_NOTHING_NEW)), says(text('Second answer.')));
    blocked.resolve(says(text('First answer.')));
    await h.idle();
    expect(lastUserText(h.calls[1]!)).toContain('Published batch 2 of 3.');
    expect(lastUserText(h.calls[2]!)).toContain('Second.');

    // Main publishes the decided state, then falls back for another: neither is news again.
    h.agentIs({
      status: 'completed',
      report: { text: 'Published batch 2 of 3.', truncated: false, appUrls: [] },
      notification: null,
      conductor: { state: 'quiet', notify: false },
    });
    h.agentIs({
      status: 'completed',
      report: { text: 'Published batch 2 of 3.', truncated: false, appUrls: [] },
      notification: null,
    });
    await h.idle();
    expect(h.calls).toHaveLength(3);
  });

  it('applies a status naming a chat to that chat, and an unnamed one to the chats that reported', async () => {
    const h = harness({
      chats: [
        { id: 'conv-1', name: 'Zeus', providerId: 'claude' },
        { id: 'conv-2', name: 'Hera', providerId: 'codex' },
      ],
    });
    h.replies.push(says(text('Caught up.')));
    await h.session.attach();
    await h.idle();
    const blocked = deferred<ChatTurnResult>();
    h.replies.push(blocked.promise);
    h.session.send('Wait.');
    await vi.waitFor(() => expect(h.session.busy).toBe(true));
    h.session.decide(held({ holdId: 'zeus' }));
    h.session.decide(held({ holdId: 'hera', conversationId: 'conv-2', text: 'Review done.' }));
    h.replies.push(
      says(
        tool('set_status', { state: 'needs_you', headline: 'Hera found a blocker', chat: 'Hera' }),
        tool('set_status', { state: 'working', headline: 'Zeus carries on', chat: 'zeus' })
      ),
      says(text('Hera needs you.'))
    );
    blocked.resolve(says(text('OK.')));
    await h.idle();
    const byHold = Object.fromEntries(h.resolved().map((call) => [call.holdId, call.decision]));
    expect(byHold.zeus).toEqual({ kind: 'quiet' });
    expect(byHold.hera).toMatchObject({ kind: 'surface', state: 'needs_you' });
  });
});

describe('a deleted chat', () => {
  it('drops its bookkeeping, while one only unloaded keeps it', async () => {
    const h = await following();
    h.replies.push(says(text('It finished.')));
    h.agentIs(working);
    h.agentIs(finished('Done.'));
    await h.idle();
    expect(h.saved.at(-1)?.chats['conv-1']).toBeDefined();

    h.agentIs(null);
    await h.idle();
    expect(h.saved.at(-1)?.chats['conv-1']).toBeDefined();

    vi.mocked(h.agent.chatDeleted).mockReturnValue(true);
    h.agentIs(null);
    await h.idle();
    expect(h.saved.at(-1)?.chats['conv-1']).toBeUndefined();
    expect(h.saved.at(-1)?.lastChatId).toBeNull();
  });
});

describe('stopping a busy agent on its own', () => {
  it('refuses stop and restart on an event turn while the agent works, not when the developer asks', async () => {
    const h = await following();
    h.agentIs(working);
    h.chatIs('conv-1', working);
    h.replies.push(
      says(tool('stop_agent'), tool('restart_agent')),
      says(text('Asking the developer.'))
    );
    // An event from another chat starts an event turn while Zeus works.
    h.session.decide({
      holdId: 'hold',
      conversationId: 'conv-1',
      kind: 'awaiting-input',
      completionReport: null,
      decideBy: Number.MAX_SAFE_INTEGER,
    });
    await h.idle();
    expect(h.agent.stop).not.toHaveBeenCalled();
    expect(h.agent.restart).not.toHaveBeenCalled();
    expect(JSON.stringify(h.calls.at(-1)!.at(-1))).toContain('middle of a turn');

    h.replies.push(says(tool('stop_agent')), says(text('Stopped it.')));
    h.session.send('Stop Zeus now.');
    await h.idle();
    expect(h.agent.stop).toHaveBeenCalledWith('conv-1');
  });
});
