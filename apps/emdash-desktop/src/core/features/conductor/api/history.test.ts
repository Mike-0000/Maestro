import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { pruneScreenshots, SCREENSHOT_OMITTED, trimHistory } from './history';

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
