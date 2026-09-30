import { describe, expect, it } from 'vitest';
import type { JevAnswer, JevAnswers } from '../jev';
import {
  completionGateRequest,
  interpretCompletionGate,
  reportSentences,
  spokenLine,
  type CompletionCandidate,
} from './completion';

const candidate = (
  text: string,
  extra: Partial<CompletionCandidate> = {}
): CompletionCandidate => ({
  name: 'Maple',
  task: 'Fix login',
  report: { text, truncated: false, appUrls: [] },
  previous: null,
  ...extra,
});

const choice = (pick: string, confidence = 0.9): JevAnswer => ({
  type: 'choice',
  choice: pick,
  confidence,
  probabilities: { [pick]: confidence },
});
const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value });

const REPORT =
  'I updated the redirect handler in auth.ts. All 42 tests pass now. Should I also update the docs?';

function gateFor(agent: CompletionCandidate) {
  const gate = completionGateRequest([agent], ['fix the login redirect']);
  const option = (index: number) =>
    Object.keys((gate.questions.a0_best as { criteria: Record<string, unknown> }).criteria).find(
      (key) => key.startsWith(`#${index} `)
    ) ?? '';
  return { gate, option };
}

describe('reportSentences', () => {
  it('strips markdown and code and drops fragments', () => {
    expect(
      reportSentences('## Done\n- Fixed **the bug** in `auth.ts` today.\n```ts\nx()\n```\nOK.')
    ).toEqual(['Fixed the bug in auth.ts today.']);
  });
});

describe('spokenLine', () => {
  it('replaces links and cuts at a word boundary', () => {
    expect(spokenLine('Maple:', 'Open http://localhost:5173 now.')).toBe('Maple: Open a link now.');
    const long = spokenLine('Maple:', 'word '.repeat(80), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('interpretCompletionGate', () => {
  it("speaks the agent's question when it needs a decision", () => {
    const agent = candidate(REPORT);
    const { gate, option } = gateFor(agent);
    const answers: JevAnswers = {
      a0_kind: choice('needs_decision'),
      a0_best: choice(option(1)),
      a0_question: choice(option(2)),
      a0_followup: noul(0.1),
    };
    expect(interpretCompletionGate(answers, gate, [agent])).toEqual([
      {
        kind: 'speak',
        text: 'Maple asks: Should I also update the docs?',
        reason: 'needs_decision',
      },
    ]);
  });

  it('keeps a repeat report on the HUD', () => {
    const agent = candidate(REPORT, { previous: REPORT });
    const { gate, option } = gateFor(agent);
    const answers: JevAnswers = {
      a0_kind: choice('done_with_result'),
      a0_novel: noul(0.1),
      a0_best: choice(option(1)),
      a0_followup: noul(0.1),
    };
    expect(interpretCompletionGate(answers, gate, [agent])[0]).toMatchObject({
      kind: 'silent',
      reason: 'repeat',
      hud: 'Maple: All 42 tests pass now.',
    });
  });

  it('leaves follow-ups, terminal tails, and low confidence to Claude', () => {
    const agent = candidate(REPORT);
    const { gate, option } = gateFor(agent);
    const base: JevAnswers = { a0_best: choice(option(1)), a0_followup: noul(0.1) };
    const verdict = (answers: JevAnswers, who = agent) =>
      interpretCompletionGate({ ...base, ...answers }, gate, [who])[0];
    expect(verdict({ a0_kind: choice('done_with_result'), a0_followup: noul(0.8) })).toMatchObject({
      kind: 'llm',
      reason: 'follow-up-requested',
    });
    expect(verdict({ a0_kind: choice('done_with_result', 0.5) })).toMatchObject({
      kind: 'llm',
      reason: 'low-confidence',
    });
    const tail = candidate(REPORT, {
      report: { text: REPORT, truncated: false, appUrls: [], source: 'terminal-tail' },
    });
    expect(verdict({ a0_kind: choice('done_with_result') }, tail)).toMatchObject({
      kind: 'llm',
      reason: 'terminal-tail',
    });
    expect(verdict({})).toMatchObject({ kind: 'llm', reason: 'no-answer' });
  });
});
