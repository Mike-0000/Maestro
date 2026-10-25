import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { keptRequestTurn } from './request-turn-history';

type Message = Anthropic.Beta.BetaMessageParam;

const earlier: Message[] = [
  { role: 'user', content: 'show all' },
  { role: 'assistant', content: 'Showing all agents.' },
];
const asked: Message = { role: 'user', content: '[Maestro event] Zulu sent request r-1.' };
const calls = (...ids: string[]): Message => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_use' as const, id, name: 'answer_request', input: {} })),
});
const results = (...ids: string[]): Message => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })),
});
const base = earlier.length;
const closing = 'Zulu asks to send Yankee a message. I approved it.';

describe('keptRequestTurn', () => {
  it('keeps a round of several calls that all have their results, and the answer after', () => {
    const turn = [
      ...earlier,
      asked,
      calls('a', 'b'),
      results('a', 'b'),
      { role: 'assistant', content: 'Done.' } as Message,
    ];
    expect(keptRequestTurn(turn, base, closing)).toEqual(turn);
  });

  it('ends a turn that ran out of rounds after settling on the closing sentence', () => {
    const turn = [...earlier, asked, calls('a'), results('a'), calls('b'), results('b')];
    expect(keptRequestTurn(turn, base, closing)).toEqual([
      ...turn,
      { role: 'assistant', content: closing },
    ]);
    // Not settled: nothing of it is kept.
    expect(keptRequestTurn(turn, base, null)).toBeNull();
  });

  it('drops a call left without its results, and what follows it', () => {
    const turn = [...earlier, asked, calls('a'), results('a'), calls('b', 'c'), results('b')];
    expect(keptRequestTurn(turn, base, closing)).toEqual([
      ...earlier,
      asked,
      calls('a'),
      results('a'),
      { role: 'assistant', content: closing },
    ]);
    // A trailing call with no results at all.
    const trailing = [...earlier, asked, calls('a')];
    expect(keptRequestTurn(trailing, base, closing)).toEqual([
      ...earlier,
      asked,
      { role: 'assistant', content: closing },
    ]);
    expect(keptRequestTurn(trailing, base, null)).toBeNull();
  });
});
