import { describe, expect, it } from 'vitest';
import {
  adoptChatThreads,
  boundThread,
  CHAT_THREAD_LIMITS,
  chatConductorThreadSchema,
  conductorTaskThreadSchema,
  emptyChatThread,
  emptyTaskThread,
  TASK_THREAD_MAX_CHATS,
  type ChatConductorEntry,
  type ChatConductorThread,
} from './thread';

const at = '2026-11-10T10:00:00.000Z';

describe('chat conductor thread', () => {
  it('starts empty, with the autonomy it was given, and parses', () => {
    const thread = emptyChatThread('conv-1', false);
    expect(thread).toMatchObject({
      version: 1,
      conversationId: 'conv-1',
      entries: [],
      messages: [],
      notes: '',
      status: null,
      autonomy: false,
      lastEventKey: null,
    });
    expect(Number.isNaN(Date.parse(thread.updatedAt))).toBe(false);
    expect(chatConductorThreadSchema.safeParse(thread).success).toBe(true);
  });

  it('accepts every kind of entry and refuses what is not a thread', () => {
    const entries: ChatConductorEntry[] = [
      { kind: 'developer', id: '1', at, text: 'get the tests green' },
      { kind: 'conductor', id: '2', at, text: 'Run `pnpm test`.' },
      {
        kind: 'action',
        id: '3',
        at,
        tool: 'send_to_agent',
        summary: 'Sent a prompt',
        status: 'done',
        detail: 'Run the tests.',
      },
      { kind: 'action', id: '4', at, tool: 'answer_prompt', summary: 'Refused', status: 'refused' },
      { kind: 'event', id: '5', at, text: 'The agent finished a turn' },
      { kind: 'error', id: '6', at, text: 'No API key.' },
    ];
    const thread = { ...emptyChatThread('conv-1', true), entries };
    expect(chatConductorThreadSchema.parse(thread).entries).toEqual(entries);

    const refused = [
      { ...thread, version: 2 },
      { ...thread, conversationId: '' },
      { ...thread, messages: undefined },
      { ...thread, messages: 'none' },
      { ...thread, entries: [{ kind: 'note', id: '1', at, text: 'x' }] },
      { ...thread, status: { state: 'busy', headline: 'x' } },
    ];
    for (const value of refused) {
      expect(chatConductorThreadSchema.safeParse(value).success).toBe(false);
    }
  });

  it('keeps the newest entries and cuts long text, notes and the headline', () => {
    const long = 'x'.repeat(CHAT_THREAD_LIMITS.entryChars + 500);
    const entries: ChatConductorEntry[] = Array.from(
      { length: CHAT_THREAD_LIMITS.entries + 25 },
      (_, index) => ({ kind: 'event', id: String(index), at, text: `event ${index}` })
    );
    entries.push(
      { kind: 'conductor', id: 'long', at, text: long },
      {
        kind: 'action',
        id: 'act',
        at,
        tool: 'send_to_agent',
        summary: long,
        status: 'done',
        detail: long,
      }
    );
    const bounded = boundThread({
      ...emptyChatThread('conv-1', true),
      entries,
      notes: 'n'.repeat(CHAT_THREAD_LIMITS.notesChars + 1),
      status: { state: 'needs_you', headline: 'h'.repeat(CHAT_THREAD_LIMITS.headlineChars + 40) },
      messages: [{ role: 'user', content: long }],
    });
    expect(bounded.entries).toHaveLength(CHAT_THREAD_LIMITS.entries);
    expect(bounded.entries[0]?.id).toBe('27');
    const [text, action] = bounded.entries.slice(-2);
    expect(text?.kind === 'conductor' && text.text.length).toBe(CHAT_THREAD_LIMITS.entryChars);
    expect(text?.kind === 'conductor' && text.text.endsWith('[… cut]')).toBe(true);
    expect(action?.kind === 'action' && action.summary.length).toBe(CHAT_THREAD_LIMITS.entryChars);
    expect(action?.kind === 'action' && action.detail?.length).toBe(CHAT_THREAD_LIMITS.entryChars);
    expect(bounded.notes).toHaveLength(CHAT_THREAD_LIMITS.notesChars);
    expect(bounded.status?.headline).toHaveLength(CHAT_THREAD_LIMITS.headlineChars);
    expect(bounded.status?.state).toBe('needs_you');
    // Model history is the renderer's to trim: cutting it here could orphan a tool result.
    expect(bounded.messages).toEqual([{ role: 'user', content: long }]);
  });

  it('leaves a thread within its limits as it is', () => {
    const thread = {
      ...emptyChatThread('conv-1', true),
      entries: [{ kind: 'developer' as const, id: '1', at, text: 'hello' }],
      notes: 'goal: ship',
      status: { state: 'working' as const, headline: 'Running tests' },
    };
    expect(boundThread(thread)).toEqual(thread);
  });
});

describe('task thread', () => {
  const chatThread = (
    conversationId: string,
    updatedAt: string,
    overrides: Partial<ChatConductorThread> = {}
  ): ChatConductorThread => ({
    ...emptyChatThread(conversationId, false),
    entries: [{ kind: 'developer', id: `d-${conversationId}`, at: updatedAt, text: 'hi' }],
    messages: [{ role: 'user', content: `history of ${conversationId}` }],
    notes: `notes of ${conversationId}`,
    status: { state: 'working', headline: conversationId },
    lastEventKey: `finished:${conversationId}`,
    sentToAgent: ['Run the tests.'],
    promptCursor: 42,
    updatedAt,
    ...overrides,
  });

  it('starts empty and parses', () => {
    const task = emptyTaskThread('task-1', true);
    expect(conductorTaskThreadSchema.parse(task)).toEqual(task);
    expect(task).toMatchObject({ version: 2, taskId: 'task-1', autonomy: true, adopted: [] });
  });

  it("adopts each chat's own thread once, in time order, with its notes and bookkeeping", () => {
    const older = chatThread('conv-a', '2026-11-09T10:00:00.000Z');
    const newer = chatThread('conv-b', '2026-11-10T10:00:00.000Z', { autonomy: true });
    const task = adoptChatThreads(emptyTaskThread('task-1', false), [
      { thread: newer, name: 'Bravo' },
      { thread: older, name: 'Atlas' },
    ]);
    expect(task.entries.map((entry) => entry.id)).toEqual(['d-conv-a', 'd-conv-b']);
    expect(task.messages).toEqual(newer.messages);
    expect(task.status).toEqual(newer.status);
    expect(task.autonomy).toBe(true);
    expect(task.notes).toBe(
      'From the chat "Atlas":\nnotes of conv-a\n\nFrom the chat "Bravo":\nnotes of conv-b'
    );
    expect(task.chats['conv-a']).toEqual({
      lastEventKey: 'finished:conv-a',
      sentToAgent: ['Run the tests.'],
      promptCursor: 42,
    });
    expect(task.adopted).toEqual(['conv-a', 'conv-b']);
    expect(task.lastChatId).toBe('conv-b');

    // Safe to repeat: what was adopted is not taken again.
    expect(adoptChatThreads(task, [{ thread: older, name: 'Atlas' }])).toBe(task);
  });

  it("keeps the task thread's own history and status when it has them", () => {
    const task = {
      ...emptyTaskThread('task-1', false),
      messages: [{ role: 'user' as const, content: 'task history' }],
      status: { state: 'done' as const, headline: 'Shipped' },
      notes: 'Task notes.',
    };
    const merged = adoptChatThreads(task, [
      { thread: chatThread('conv-a', '2026-11-09T10:00:00.000Z'), name: 'Atlas' },
    ]);
    expect(merged.messages).toEqual(task.messages);
    expect(merged.status).toEqual(task.status);
    expect(merged.notes.startsWith('Task notes.\n\nFrom the chat "Atlas"')).toBe(true);
  });

  it('keeps bookkeeping for a bounded number of chats', () => {
    const chats = Object.fromEntries(
      Array.from({ length: TASK_THREAD_MAX_CHATS + 5 }, (_, index) => [
        `conv-${index}`,
        { lastEventKey: null, sentToAgent: [], promptCursor: null },
      ])
    );
    const bounded = boundThread({ ...emptyTaskThread('task-1', false), chats });
    expect(Object.keys(bounded.chats)).toHaveLength(TASK_THREAD_MAX_CHATS);
    expect(bounded.chats[`conv-${TASK_THREAD_MAX_CHATS + 4}`]).toBeDefined();
  });
});
