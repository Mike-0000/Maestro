import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  CODE_CHECK_REMOVED,
  compactCodeChecks,
  CONTEXT_OMITTED,
  dropStaleContexts,
  hasCodeCheck,
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

describe('trimHistory', () => {
  it('keeps short histories untouched', () => {
    const messages = [...turn(1, false), ...turn(2, true)];
    expect(trimHistory(messages, 4)).toBe(messages);
  });

  it('cuts at turn starts so tool pairs survive', () => {
    const messages = [1, 2, 3, 4, 5].flatMap((index) => turn(index, index % 2 === 0));
    const trimmed = trimHistory(messages, 2);
    expect(trimmed[0]).toEqual({ role: 'user', content: 'utterance 4' });
    expect(trimmed).toHaveLength(turn(4, true).length + turn(5, false).length);
    const toolUses = trimmed.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_use')
        : []
    );
    const toolResults = trimmed.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_result')
        : []
    );
    expect(toolUses).toHaveLength(toolResults.length);
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
    expect(trimHistory(kept, 1)).toEqual(kept.slice(3));
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
