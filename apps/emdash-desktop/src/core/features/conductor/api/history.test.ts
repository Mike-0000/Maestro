import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { trimHistory } from './history';

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
