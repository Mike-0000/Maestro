import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  conversationBreakpoints,
  turnStartIndex,
  withConversationBreakpoints,
} from './prompt-cache';

type Message = Anthropic.Beta.BetaMessageParam;

const history: Message[] = [
  { role: 'user', content: 'open Atlas' },
  { role: 'assistant', content: [{ type: 'text', text: 'Opened Atlas.' }] },
];
const turnStart: Message = { role: 'user', content: '<context>\n</context>\n\nstatus?' };
const toolRound: Message[] = [
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Look first.', signature: 'sig' },
      { type: 'tool_use', id: 't1', name: 'list_agents', input: {} },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Atlas: idle' }] },
];

describe('conversation breakpoints', () => {
  it('finds the turn start: the last plain user message, never a tool result', () => {
    expect(turnStartIndex([...history, turnStart, ...toolRound])).toBe(2);
    expect(turnStartIndex([])).toBe(-1);
  });

  it('marks the end of the stored history and the last message', () => {
    expect(conversationBreakpoints([...history, turnStart])).toEqual([1, 2]);
    expect(conversationBreakpoints([...history, turnStart, ...toolRound])).toEqual([1, 4]);
    expect(conversationBreakpoints([turnStart])).toEqual([0]);
    expect(conversationBreakpoints([])).toEqual([]);
  });

  it('puts the marker on the last block that can carry one, on a copy', () => {
    const messages = [...history, turnStart, ...toolRound];
    const sent = withConversationBreakpoints(messages);
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Opened Atlas.', cache_control: { type: 'ephemeral' } }],
    });
    expect(sent[2]).toEqual(turnStart);
    expect(sent[4]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'Atlas: idle',
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    // The caller's messages are untouched.
    expect(JSON.stringify(messages)).not.toContain('cache_control');
  });

  it('never marks a thinking block, and turns a plain last message into a marked text block', () => {
    const sent = withConversationBreakpoints([turnStart, toolRound[0]!]);
    const blocks = sent[1]!.content as { type: string; cache_control?: unknown }[];
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(withConversationBreakpoints([turnStart])[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: turnStart.content, cache_control: { type: 'ephemeral' } }],
    });
  });

  it('drops markers the messages carried already, so a request never holds more than four', () => {
    const stale: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }],
    };
    const sent = withConversationBreakpoints([stale, ...history, turnStart]);
    expect(JSON.stringify(sent).match(/cache_control/g)).toHaveLength(2);
  });
});
