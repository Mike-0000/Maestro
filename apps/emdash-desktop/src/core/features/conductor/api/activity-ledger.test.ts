import { describe, expect, it } from 'vitest';
import {
  ActivityLedger,
  eventAgents,
  formatAgo,
  ledgerAction,
  LEDGER_TURNS,
} from './activity-ledger';
import type { ConductorTurnRecord } from './contract';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-04T22:20:00.000Z');

const MODDING =
  'do you see a way for us to build a really polished and production-ready modding harness';

function record(overrides: Partial<ConductorTurnRecord>): ConductorTurnRecord {
  return {
    at: new Date(NOW - MINUTE).toISOString(),
    utterance: '',
    route: 'grammar',
    actions: [],
    reply: '',
    latencyMs: 10,
    ...overrides,
  };
}

describe('formatAgo', () => {
  it('reads as speech', () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 4 * MINUTE, NOW)).toBe('4 min ago');
    expect(formatAgo(NOW - 3 * 60 * MINUTE, NOW)).toBe('3 h ago');
    expect(formatAgo(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe('3 days ago');
  });
});

describe('ledgerAction', () => {
  it('reads tool inputs as objects and as the JSON the log stores', () => {
    const input = { agent: 'Atlas 3', text: MODDING };
    const live = ledgerAction({ tool: 'send_to_agent', input, outcome: 'Sent to Atlas 3.' });
    expect(live).toMatchObject({ agent: 'Atlas 3', text: MODDING });
    expect(
      ledgerAction({ tool: 'send_to_agent', input: JSON.stringify(input), outcome: 'Sent.' })
    ).toMatchObject({ agent: 'Atlas 3', text: MODDING });
    expect(ledgerAction({ tool: 'approve_plan', input: {}, outcome: 'ok' })).toEqual({
      tool: 'approve_plan',
      outcome: 'ok',
    });
  });
});

describe('ActivityLedger', () => {
  it('puts a fast-path send in the context with its exact text', () => {
    // The log's failure: the grammar sent this to Atlas 3, then "that message was supposed to go
    // to Atlas in ACE COMBAT 8" reached a model that had never seen the message.
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(
      record({
        utterance: `Ask Atlas: ${MODDING}?`,
        actions: [
          {
            tool: 'send_to_agent',
            input: { agent: 'Atlas 3', text: MODDING },
            outcome: 'Starting Atlas 3; it gets the message when it is ready.',
          },
        ],
        reply: 'Starting Atlas 3; it gets the message when it is ready.',
      })
    );
    const lines = ledger.contextLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`- 1 min ago: sent to Atlas 3: “${MODDING}”`);
  });

  it('shows the newest text whole and older ones as previews', () => {
    const ledger = new ActivityLedger(() => NOW);
    const long = 'word '.repeat(200).trim();
    for (const [index, agent] of ['Lima 3', 'Echo 3'].entries()) {
      ledger.noteRecord(
        record({
          at: new Date(NOW - (10 - index) * MINUTE).toISOString(),
          route: 'llm',
          utterance: `tell ${agent} the plan`,
          actions: [{ tool: 'send_to_agent', input: { agent, text: long }, outcome: 'Sent.' }],
        })
      );
    }
    const [, newest, older] = ledger.contextLines();
    expect(newest).toContain('sent to Echo 3');
    expect(newest).toContain(long);
    expect(older).toContain('sent to Lima 3');
    expect(older).not.toContain(long);
    expect(older).toContain('you said “tell Lima 3 the plan”');
  });

  it('names the agent a spawn created and never reports a failed action as done', () => {
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(
      record({
        route: 'llm',
        utterance: 'start a claude agent in chorus to fix the cancel button',
        actions: [
          {
            tool: 'spawn_agent',
            input: { project: 'chorus', provider: 'claude', prompt: 'Fix the cancel button.' },
            outcome: 'Created task "Fix cancel button"; it will appear on the canvas as Tango 3.',
          },
          {
            tool: 'send_to_agent',
            input: { agent: 'Maple 3', text: 'hold on' },
            outcome: 'The user cancelled this before it was sent.',
            status: 'cancelled',
          },
          {
            tool: 'send_to_agent',
            input: { agent: 'Echo', text: 'hi' },
            outcome: 'No agent matches "Echo".',
            status: 'failed',
          },
        ],
      })
    );
    const line = ledger.contextLines()[1] ?? '';
    // A task name containing "cancel" is not a cancellation.
    expect(line).toContain('started Tango 3 in chorus: “Fix the cancel button.”');
    expect(line).toContain('tried to send to Maple 3 (cancelled, it did not happen)');
    expect(line).toContain(
      'tried to send to Echo (FAILED, it did not happen: No agent matches "Echo".)'
    );
    expect(ledger.describe(5)).toContain('send_to_agent → Echo [failed, it did not happen]');
  });

  it('leaves completion narration out of the context but keeps real replies', () => {
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(record({ utterance: '[completion] Atlas 3', reply: 'Atlas finished.' }));
    expect(ledger.contextLines()).toEqual([]);
    ledger.noteRecord(
      record({ route: 'llm', utterance: 'send this to Chorus agent', reply: 'Which one?' })
    );
    expect(ledger.contextLines()[1]).toBe(
      '- 1 min ago: you said “send this to Chorus agent” → replied “Which one?”'
    );
  });

  it('does not put an agent request in the developer mouth', () => {
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(
      record({ route: 'llm', utterance: '[request r-2] Atlas: question', reply: 'Told it main.' })
    );
    expect(ledger.contextLines()[1]).toBe(
      '- 1 min ago: [request r-2] Atlas: question → replied “Told it main.”'
    );
  });

  it('drops quiet completions before taking the newest turns', () => {
    // Oct 16: eight finished-agent reports in a row left the activity block empty.
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(
      record({
        at: new Date(NOW - 30 * MINUTE).toISOString(),
        route: 'llm',
        utterance: 'keep Echo on the parser',
        reply: 'Will do.',
      })
    );
    for (let index = 0; index < 8; index++) {
      ledger.noteRecord(
        record({
          at: new Date(NOW - (20 - index) * MINUTE).toISOString(),
          route: 'llm',
          utterance: `[completion] Agent ${index}`,
          reply: 'NO_NEWS',
        })
      );
    }
    const lines = ledger.contextLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('you said “keep Echo on the parser”');
  });

  it("keeps the developer's newest turns in the context after a burst of requests", () => {
    const ledger = new ActivityLedger(() => NOW);
    for (const [index, said] of ['first thing', 'second thing', 'third thing'].entries()) {
      ledger.noteRecord(
        record({
          at: new Date(NOW - (60 - index) * MINUTE).toISOString(),
          route: 'llm',
          utterance: said,
          reply: 'ok',
        })
      );
    }
    for (let index = 0; index < 8; index++) {
      ledger.noteRecord(
        record({
          at: new Date(NOW - (40 - index) * MINUTE).toISOString(),
          route: 'llm',
          utterance: `[request r-${index}] Atlas: ask_conductor`,
          actions: [{ tool: 'answer_request', input: { id: `r-${index}` }, outcome: 'Answered.' }],
          reply: 'Answered Atlas.',
        })
      );
    }
    const lines = ledger.contextLines().slice(1);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('[request r-7]');
    expect(lines.slice(-2).map((line) => /you said “(.+?)”/.exec(line)?.[1])).toEqual([
      'third thing',
      'second thing',
    ]);
    expect(lines.join('\n')).not.toContain('first thing');
  });

  it('finds agents named in what started an event turn', () => {
    expect(eventAgents('[request r-12] Atlas 3: ask_conductor')).toEqual(['Atlas 3']);
    expect(eventAgents('[completion] Lima 3, Echo')).toEqual(['Lima 3', 'Echo']);
    expect(eventAgents('tell Atlas about it')).toEqual([]);
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(
      record({
        route: 'llm',
        utterance: '[request r-12] Atlas 3: spawn_agent',
        actions: [{ tool: 'answer_request', input: { id: 'r-12' }, outcome: 'Approved.' }],
        reply: 'Started a helper for Atlas.',
      })
    );
    ledger.noteRecord(
      record({ route: 'llm', utterance: '[completion] Lima 3, Echo', reply: 'Lima is done.' })
    );
    ledger.noteRecord(
      record({ route: 'llm', utterance: 'what is Atlas doing', reply: 'Working.' })
    );
    const atlas = ledger.describe(5, 'atlas');
    expect(atlas).toContain(
      'Maestro event, not the developer: [request r-12] Atlas 3: spawn_agent'
    );
    expect(atlas).not.toContain('the developer said: “[request');
    // A developer's words that merely mention an agent are not an event about it.
    expect(atlas).not.toContain('what is Atlas doing');
    expect(ledger.describe(5, 'Echo', true)).toContain(
      'Maestro event, not the developer: [completion] Lima 3, Echo'
    );
    expect(ledger.describe(5, 'lima 3', true)).toContain('[completion] Lima 3, Echo');
    expect(ledger.describe(5)).toContain('the developer said: “what is Atlas doing”');
  });

  it('gives full texts, filtered by agent, to the recent_activity tool', () => {
    const ledger = new ActivityLedger(() => NOW);
    const long = 'detail '.repeat(300).trim();
    ledger.noteRecord(
      record({
        utterance: 'tell lima the details',
        actions: [
          { tool: 'send_to_agent', input: { agent: 'Lima 3', text: long }, outcome: 'Sent.' },
        ],
      })
    );
    expect(ledger.describe(5)).toContain(`exact text:\n${long}`);
    expect(ledger.describe(5, 'lima')).toContain('→ Lima 3');
    expect(ledger.describe(5, 'Lima', true)).toBe('Nothing recent involving Lima.');
    expect(ledger.describe(5, 'lima 3', true)).toContain('→ Lima 3');
    expect(ledger.describe(5, 'Echo 3')).toBe('Nothing recent involving Echo 3.');
    expect(new ActivityLedger().describe(5)).toBe('Nothing has happened yet.');
  });

  it('recalls logged turns behind live ones and stays bounded', () => {
    const ledger = new ActivityLedger(() => NOW);
    ledger.noteRecord(record({ at: new Date(NOW).toISOString(), utterance: 'live', reply: 'ok' }));
    ledger.seed(
      Array.from({ length: LEDGER_TURNS + 5 }, (_, index) =>
        record({
          at: new Date(NOW - (index + 1) * MINUTE).toISOString(),
          utterance: `old ${index}`,
          reply: 'ok',
        })
      )
    );
    const recent = ledger.recent();
    expect(recent).toHaveLength(LEDGER_TURNS);
    expect(recent[0]?.said).toBe('live');
    expect(recent[1]?.said).toBe('old 0');
    ledger.clear();
    expect(ledger.recent()).toEqual([]);
  });
});
