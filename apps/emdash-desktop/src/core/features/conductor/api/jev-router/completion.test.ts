import { describe, expect, it } from 'vitest';
import type { JevAnswer, JevAnswers } from '../jev';
import {
  completionGateRequest,
  interpretCompletionGate,
  isInputOrChrome,
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

  it("hands Claude the agent's own question or best sentence to fall back on", () => {
    const agent = candidate(REPORT);
    const { gate, option } = gateFor(agent);
    const lowConfidence = interpretCompletionGate(
      {
        a0_kind: choice('needs_decision', 0.5),
        a0_best: choice(option(1)),
        a0_question: choice(option(2)),
        a0_followup: noul(0.1),
      },
      gate,
      [agent]
    )[0];
    expect(lowConfidence).toEqual({
      kind: 'llm',
      reason: 'low-confidence',
      fallback: 'Maple asks: Should I also update the docs?',
    });
    const noQuestion = interpretCompletionGate(
      { a0_kind: choice('done_with_result', 0.5), a0_best: choice(option(1)) },
      gate,
      [agent]
    )[0];
    expect(noQuestion).toMatchObject({ fallback: 'Maple: All 42 tests pass now.' });
  });
});

describe('terminal input and chrome', () => {
  const LINES = [
    "❯ keep going until it's fully done",
    '✔ Update installed · Restart to update',
    '✻ Baked for 6m 42s',
    '● Stop Task',
    '⏵⏵ bypass permissions on',
    '✻ Churned for 3m 2s',
    '※ recap',
    '⎿ Tip:',
    '› run the tests again please',
  ];

  it('is recognized, and real sentences are not', () => {
    for (const line of LINES) expect(isInputOrChrome(line)).toBe(true);
    expect(isInputOrChrome('I updated the redirect handler in auth.ts.')).toBe(false);
  });

  it('stays out of the best and question candidates but in the text Jev reads', () => {
    const text = `${REPORT}\n${LINES.join('\n')}`;
    const gate = completionGateRequest([candidate(text)], []);
    const options = Object.keys(
      (gate.questions.a0_best as { criteria: Record<string, unknown> }).criteria
    ).join('\n');
    expect(options).toContain('I updated the redirect');
    for (const marker of ['keep going', 'Baked for', 'Stop Task', 'bypass', 'Churned']) {
      expect(options).not.toContain(marker);
    }
    const state = JSON.stringify(gate.state);
    expect(state).toContain('keep going until');
    expect(state).toContain('Baked for');
  });
});

describe('quiet and thin verdicts', () => {
  it('keeps a confident progress_no_news quiet whatever novel says', () => {
    const agent = candidate("I'll report the result when it finishes running.", {
      previous: 'Working on it, more soon.',
    });
    const { gate, option } = gateFor(agent);
    const verdict = interpretCompletionGate(
      {
        a0_kind: choice('progress_no_news', 0.9),
        a0_novel: noul(0.8),
        a0_best: choice(option(0)),
        a0_followup: noul(0.1),
      },
      gate,
      [agent]
    )[0];
    expect(verdict).toMatchObject({ kind: 'silent', reason: 'no-news' });
  });

  it('sends content-free one-liners to the model instead of speaking them', () => {
    for (const line of [
      'I found and fixed it.',
      'The push worked.',
      'All four recommendations are built.',
    ]) {
      const agent = candidate(line);
      const { gate, option } = gateFor(agent);
      const verdict = interpretCompletionGate(
        { a0_kind: choice('done_with_result'), a0_best: choice(option(0)), a0_followup: noul(0.1) },
        gate,
        [agent]
      )[0];
      expect(verdict).toMatchObject({ kind: 'llm', reason: 'thin-sentence' });
    }
  });

  it('speaks a full sentence only at best-sentence confidence 0.7', () => {
    const agent = candidate(REPORT);
    const { gate, option } = gateFor(agent);
    const run = (confidence: number) =>
      interpretCompletionGate(
        {
          a0_kind: choice('done_with_result'),
          a0_best: choice(option(0), confidence),
          a0_followup: noul(0.1),
        },
        gate,
        [agent]
      )[0];
    expect(run(0.8)).toMatchObject({ kind: 'speak' });
    expect(run(0.6)).toMatchObject({ kind: 'llm', reason: 'thin-sentence' });
  });
});

describe('Claude Code reply markers', () => {
  it("keeps the agent's own sentences and drops tool-call and status lines", () => {
    const sentences = reportSentences(
      '⏺ I updated the redirect handler and the tests pass.\n● Bash(npm test --silent)\n⏺ Read(src/auth.ts)\n● Stop Task'
    );
    expect(sentences).toContain('I updated the redirect handler and the tests pass.');
    expect(sentences.filter((sentence) => !isInputOrChrome(sentence))).toEqual([
      'I updated the redirect handler and the tests pass.',
    ]);
    expect(isInputOrChrome('● Stop Task')).toBe(true);
    expect(isInputOrChrome('⏺ Update(src/auth.ts)')).toBe(true);
    expect(isInputOrChrome('● I fixed the redirect handler.')).toBe(false);
  });
});
