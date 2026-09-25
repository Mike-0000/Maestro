import { describe, expect, it } from 'vitest';
import {
  interpretPermissionRisk,
  interpretPlanReview,
  interpretRouting,
  interpretUrgency,
  parallelPairs,
  planReviewQuestions,
  routingQuestions,
  type JevAnswers,
} from './jev';
import type { PlanSubtask } from './plan';
import type { RosterAgent } from './resolver';

const roster: RosterAgent[] = [
  { id: 'a', name: 'Claude 1', providerLabel: 'Claude', taskName: 'auth' },
  { id: 'b', name: 'Codex 1', providerLabel: 'Codex', taskName: 'tests' },
];

function choice(value: string, confidence: number) {
  return {
    type: 'choice' as const,
    choice: value,
    probabilities: { [value]: confidence },
    confidence,
  };
}

describe('routingQuestions', () => {
  it('offers every roster agent plus a none option', () => {
    const questions = routingQuestions(roster);
    const target = questions.target;
    expect(target?.type).toBe('choice');
    if (target?.type === 'choice') {
      expect(Object.keys(target.criteria)).toEqual(['Claude 1', 'Codex 1', '(none)']);
    }
  });
});

describe('interpretRouting', () => {
  it('executes a confident focus on a confident agent', () => {
    const answers: JevAnswers = {
      intent: choice('focus', 0.95),
      target: choice('Codex 1', 0.9),
      decompose: { type: 'noul', noul: 0.02 },
    };
    expect(interpretRouting(answers, 0.8)).toEqual({
      kind: 'direct',
      intent: 'focus',
      agent: 'Codex 1',
      confidence: 0.9,
    });
  });

  it('needs no agent for overview and next', () => {
    const answers: JevAnswers = {
      intent: choice('overview', 0.92),
      target: choice('(none)', 0.9),
      decompose: { type: 'noul', noul: 0 },
    };
    expect(interpretRouting(answers, 0.8)).toMatchObject({ kind: 'direct', intent: 'overview' });
  });

  it('defers to Claude when unsure about the agent', () => {
    const answers: JevAnswers = {
      intent: choice('status', 0.95),
      target: choice('Claude 1', 0.55),
      decompose: { type: 'noul', noul: 0.1 },
    };
    expect(interpretRouting(answers, 0.8)).toEqual({ kind: 'model', mode: 'command' });
  });

  it('never executes messages or new work; picks plan mode for broad goals', () => {
    const answers: JevAnswers = {
      intent: choice('new_work', 0.99),
      target: choice('(none)', 0.9),
      decompose: { type: 'noul', noul: 0.87 },
    };
    expect(interpretRouting(answers, 0.8)).toEqual({ kind: 'model', mode: 'plan' });
  });

  it('falls back safely on missing answers', () => {
    expect(interpretRouting({}, 0.8)).toEqual({ kind: 'model', mode: 'command' });
  });
});

describe('risk and urgency', () => {
  it('maps the risk score to a level', () => {
    const risk = interpretPermissionRisk({
      risk: { type: 'score', score: 2.8, probabilities: {}, confidence: 0.7 },
    });
    expect(risk?.level).toBe('high');
    expect(
      interpretPermissionRisk({
        risk: { type: 'score', score: 0.2, probabilities: {}, confidence: 1 },
      })?.level
    ).toBe('low');
    expect(interpretPermissionRisk({})).toBeNull();
  });

  it('normalizes urgency to 0..1', () => {
    expect(
      interpretUrgency({ urgency: { type: 'score', score: 3, probabilities: {}, confidence: 1 } })
    ).toBe(1);
    expect(interpretUrgency({})).toBeNull();
  });
});

describe('plan review', () => {
  const subtasks: PlanSubtask[] = [
    { title: 'API', provider: 'claude', prompt: 'Build the API', owned_paths: ['src/api/**'] },
    { title: 'UI', provider: 'codex', prompt: 'Build the UI', owned_paths: ['src/ui/**'] },
    {
      title: 'Docs',
      provider: 'claude',
      prompt: 'Document it',
      owned_paths: ['docs/**'],
      sequential_after: 'API',
    },
  ];

  it('only pairs subtasks that run in parallel', () => {
    expect(parallelPairs(subtasks)).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(Object.keys(planReviewQuestions(subtasks))).toEqual([
      'clarity_0',
      'clarity_1',
      'clarity_2',
      'overlap_0_1',
      'overlap_1_2',
    ]);
  });

  it('rejects likely overlap and vague prompts with a reason the model can act on', () => {
    const review = interpretPlanReview(
      {
        overlap_0_1: { type: 'noul', noul: 0.9 },
        overlap_1_2: { type: 'noul', noul: 0.1 },
        clarity_0: { type: 'score', score: 2, probabilities: {}, confidence: 0.9 },
        clarity_1: { type: 'score', score: 2, probabilities: {}, confidence: 0.9 },
        clarity_2: { type: 'score', score: 0.2, probabilities: {}, confidence: 0.8 },
      },
      subtasks
    );
    expect(review.ok).toBe(false);
    if (!review.ok) {
      expect(review.reason).toContain('"API" and "UI"');
      expect(review.reason).toContain('"Docs" is too vague');
    }
  });

  it('accepts a clean plan', () => {
    expect(
      interpretPlanReview({ overlap_0_1: { type: 'noul', noul: 0.2 } }, subtasks.slice(0, 2))
    ).toEqual({ ok: true });
  });
});
