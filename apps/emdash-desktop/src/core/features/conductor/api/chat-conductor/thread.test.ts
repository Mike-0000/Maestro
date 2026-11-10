import { describe, expect, it } from 'vitest';
import {
  boundThread,
  CHAT_THREAD_LIMITS,
  chatConductorThreadSchema,
  emptyChatThread,
  type ChatConductorEntry,
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
