import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  CODE_CHECK_REMOVED,
  compactCodeChecks,
  CONTEXT_OMITTED,
  dropStaleContexts,
  hasCodeCheck,
  HISTORY_BUDGET,
  type HistoryBudget,
  MAESTRO_EVENT_MARK,
  pruneScreenshots,
  SCREENSHOT_OMITTED,
  trimHistory,
} from './history';
import { conductorUserMessage } from './system-prompt';

type Message = Anthropic.Beta.BetaMessageParam;

function turn(index: number, withTool: boolean): Message[] {
  const messages: Message[] = [{ role: 'user', content: `utterance ${index}` }];
  if (withTool) {
    messages.push(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${index}`, name: 'list_agents', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: 'ok' }] }
    );
  }
  messages.push({ role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] });
  return messages;
}

/** A turn Maestro started: an agent finished, or sent a request. */
function eventTurn(index: number, withTool: boolean): Message[] {
  const [, ...rest] = turn(index, withTool);
  return [{ role: 'user', content: `${MAESTRO_EVENT_MARK} event ${index}` }, ...rest];
}

/** A plain sliding window of `turns`, for tests about where a cut lands. */
const window = (turns: number): HistoryBudget => ({ high: turns, low: turns, developer: 0 });

/** What a turn starts with, in order: "utterance 3", "event 4". */
function starts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'user' && typeof message.content === 'string'
      ? [message.content.replace(`${MAESTRO_EVENT_MARK} `, '')]
      : []
  );
}

/** Starts on a turn, alternates roles, and every tool_use is answered by the next message. */
function expectValidSequence(messages: readonly Message[]): void {
  expect(messages[0]?.role).toBe('user');
  expect(typeof messages[0]?.content).toBe('string');
  for (const [index, message] of messages.entries()) {
    if (index > 0) expect(message.role).not.toBe(messages[index - 1]?.role);
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    const uses = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
    if (uses.length === 0) continue;
    const next = messages[index + 1];
    const answered =
      next && Array.isArray(next.content)
        ? next.content.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
        : [];
    expect(answered).toEqual(uses);
  }
}

describe('trimHistory', () => {
  it('keeps short histories untouched', () => {
    const messages = [...turn(1, false), ...turn(2, true)];
    expect(trimHistory(messages, window(4))).toBe(messages);
  });

  it('cuts at turn starts so tool pairs survive', () => {
    const messages = [1, 2, 3, 4, 5].flatMap((index) => turn(index, index % 2 === 0));
    const trimmed = trimHistory(messages, window(2));
    expect(trimmed[0]).toEqual({ role: 'user', content: 'utterance 4' });
    expect(trimmed).toHaveLength(turn(4, true).length + turn(5, false).length);
    expectValidSequence(trimmed);
  });

  it('grows to the high mark and then cuts back to the low mark in one go', () => {
    let history: Message[] = [];
    const cutsAt: number[] = [];
    for (let index = 1; index <= 40; index++) {
      const before = history;
      history = trimHistory([...history, ...turn(index, index % 3 === 0)]);
      const turns = starts(history).length;
      expect(turns).toBeLessThanOrEqual(HISTORY_BUDGET.high);
      if (turns === HISTORY_BUDGET.low && index > HISTORY_BUDGET.low) {
        cutsAt.push(index);
        expect(starts(history)).toEqual(
          Array.from({ length: HISTORY_BUDGET.low }, (_, i) => `utterance ${index - 7 + i}`)
        );
      } else {
        // Between cuts the stored history only grows: the next request starts with the same
        // bytes, so the cached prefix holds.
        expect(history.slice(0, before.length)).toEqual(before);
      }
      expectValidSequence(history);
    }
    // One cut every (high - low + 1) turns, not one per turn.
    expect(cutsAt).toEqual([15, 22, 29, 36]);
  });

  it("keeps the developer's newest turns through a burst of Maestro events", () => {
    let history: Message[] = [1, 2, 3, 4, 5].flatMap((index) => turn(index, index === 2));
    for (let index = 6; index <= 40; index++) {
      history = trimHistory([...history, ...eventTurn(index, index % 2 === 0)]);
      expectValidSequence(history);
    }
    const kept = starts(history);
    // The last four things the developer said, then the newest events.
    expect(kept.slice(0, 4)).toEqual(['utterance 2', 'utterance 3', 'utterance 4', 'utterance 5']);
    expect(kept.at(-1)).toBe('event 40');
    expect(kept.filter((start) => start.startsWith('event')).length).toBeGreaterThanOrEqual(
      HISTORY_BUDGET.low - HISTORY_BUDGET.developer
    );
  });

  it('cuts to the newest turns of any kind once the developer turns are kept', () => {
    const messages = [
      ...turn(1, false),
      ...eventTurn(2, true),
      ...turn(3, false),
      ...eventTurn(4, false),
      ...eventTurn(5, true),
      ...turn(6, false),
    ];
    const trimmed = trimHistory(messages, { high: 5, low: 4, developer: 2 });
    expect(starts(trimmed)).toEqual(['utterance 3', 'event 4', 'event 5', 'utterance 6']);
    expectValidSequence(trimmed);
    // Older developer turns are dropped like any other once the budget is full.
    expect(starts(trimHistory(messages, { high: 5, low: 3, developer: 3 }))).toEqual([
      'utterance 1',
      'utterance 3',
      'utterance 6',
    ]);
  });
});

describe('pruneScreenshots', () => {
  const shot = (id: string): Message => ({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: [
          { type: 'text', text: `page ${id}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
      },
    ],
  });
  const hasImage = (message: Message) => JSON.stringify(message).includes('"type":"image"');

  it('keeps only the latest screenshot for the next request', () => {
    const messages: Message[] = [{ role: 'user', content: 'look' }, shot('a'), shot('b')];
    const pruned = pruneScreenshots(messages);
    expect(pruned[0]).toBe(messages[0]);
    expect(hasImage(pruned[1]!)).toBe(false);
    expect(JSON.stringify(pruned[1])).toContain(SCREENSHOT_OMITTED);
    expect(JSON.stringify(pruned[1])).toContain('page a');
    expect(pruned[2]).toBe(messages[2]);
  });

  it('drops every screenshot from stored history', () => {
    expect(pruneScreenshots([shot('a'), shot('b')], 0).some(hasImage)).toBe(false);
  });
});

describe('dropStaleContexts', () => {
  it('keeps what was said and drops the state it was sent with', () => {
    const messages: Message[] = [
      { role: 'user', content: conductorUserMessage('Agents:\n- Atlas 3: working', 'focus Atlas') },
      { role: 'assistant', content: [{ type: 'text', text: 'Focused Atlas 3.' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'user', content: 'no context here' },
    ];
    const kept = dropStaleContexts(messages);
    expect(kept[0]).toEqual({ role: 'user', content: `${CONTEXT_OMITTED}\n\nfocus Atlas` });
    expect(kept.slice(1)).toEqual(messages.slice(1));
    // Still a turn start for trimHistory.
    expect(trimHistory(kept, window(1))).toEqual(kept.slice(3));
  });
});

describe('code checks in history', () => {
  const check = (id: string): Message[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'investigate', input: { questions: ['q?'] } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content:
            'Results from a read-only code scout.\n\n<code-check question="q?">yes</code-check>',
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'There is one.' }] },
  ];
  const developer = (text: string): Message[] => [
    { role: 'user', content: text },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ];
  const event: Message[] = [
    { role: 'user', content: `${MAESTRO_EVENT_MARK} Atlas finished its turn.` },
    { role: 'assistant', content: [{ type: 'text', text: 'Atlas is done.' }] },
  ];

  it('finds a check result, and only in a tool result', () => {
    expect(hasCodeCheck([{ role: 'user', content: 'do we have a helper' }, ...check('c1')])).toBe(
      true
    );
    expect(hasCodeCheck(developer('what does <code-check mean'))).toBe(false);
    expect(hasCodeCheck([])).toBe(false);
  });

  it('keeps a result for the turn that made it and the next two requests', () => {
    const made: Message[] = [{ role: 'user', content: 'do we have a helper' }, ...check('c1')];
    expect(hasCodeCheck(compactCodeChecks(made))).toBe(true);
    const one = [...made, ...developer('extend it')];
    expect(hasCodeCheck(compactCodeChecks(one))).toBe(true);
    const two = [...one, ...developer('and add a test')];
    const compacted = compactCodeChecks(two);
    expect(hasCodeCheck(compacted)).toBe(false);
    expect(JSON.stringify(compacted)).toContain(CODE_CHECK_REMOVED);
    // The tool call keeps its result, so the history is still a valid message sequence.
    expect(compacted).toHaveLength(two.length);
  });

  it('does not count turns Maestro started', () => {
    const made: Message[] = [{ role: 'user', content: 'do we have a helper' }, ...check('c1')];
    const withEvents = [...made, ...event, ...event, ...developer('extend it')];
    expect(hasCodeCheck(compactCodeChecks(withEvents))).toBe(true);
  });

  it('returns the same messages when there is no check in them', () => {
    const plain = developer('focus Atlas');
    expect(compactCodeChecks(plain)).toBe(plain);
  });
});
