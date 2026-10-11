import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  cachesByBreakpoint,
  fromOpenAiChoice,
  toOpenAiMessages,
  toOpenAiTools,
} from './openrouter-format';

describe('toOpenAiMessages', () => {
  it('maps a tool round trip and drops thinking blocks', () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'focus claude one' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hm', signature: 'sig' },
          { type: 'text', text: 'Focusing.' },
          { type: 'tool_use', id: 'call_1', name: 'focus_agent', input: { agent: 'Claude 1' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Focused Claude 1.' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'nope', is_error: true },
        ],
      },
    ];
    expect(toOpenAiMessages('SYS', messages)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'focus claude one' },
      {
        role: 'assistant',
        content: 'Focusing.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'focus_agent', arguments: '{"agent":"Claude 1"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Focused Claude 1.' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: nope' },
    ]);
  });

  it('maps tools to functions', () => {
    const tools = toOpenAiTools([
      {
        name: 'show_all',
        description: 'Zoom out',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'show_all',
        description: 'Zoom out',
        parameters: { type: 'object', properties: {} },
      },
    });
  });
});

describe('fromOpenAiChoice', () => {
  it('turns tool calls into tool_use blocks', () => {
    const result = fromOpenAiChoice({
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'focus_agent', arguments: '{"agent":"Codex 1"}' },
          },
        ],
      },
    });
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'focus_agent', input: { agent: 'Codex 1' } },
    ]);
  });

  it('reports text, length, and refusals', () => {
    expect(fromOpenAiChoice({ finish_reason: 'stop', message: { content: ' Done. ' } })).toEqual({
      content: [{ type: 'text', text: 'Done.', citations: null }],
      stopReason: 'end_turn',
    });
    expect(
      fromOpenAiChoice({ finish_reason: 'length', message: { content: 'x' } }).stopReason
    ).toBe('max_tokens');
    expect(fromOpenAiChoice({ message: { content: null, refusal: 'no' } }).stopReason).toBe(
      'refusal'
    );
  });
});

describe('toOpenAiMessages caching', () => {
  it('marks the system prompt as a cache breakpoint only when asked', () => {
    expect(toOpenAiMessages('SYS', [], { cacheSystem: true })).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      },
    ]);
    expect(toOpenAiMessages('SYS', [])).toEqual([{ role: 'system', content: 'SYS' }]);
  });

  it('asks for a breakpoint for Anthropic models only', () => {
    expect(cachesByBreakpoint('anthropic/claude-haiku-5.5:nitro')).toBe(true);
    expect(cachesByBreakpoint('openai/gpt-6')).toBe(false);
  });
});

describe('toOpenAiMessages screenshots', () => {
  it('keeps tool text and hoists images into a following user message', () => {
    const out = toOpenAiMessages('SYS', [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Page: http://localhost:5173/' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
            ],
          },
        ],
      },
    ]);
    expect(out.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'Page: http://localhost:5173/' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshots returned by the tool calls above:' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ]);
  });
});
