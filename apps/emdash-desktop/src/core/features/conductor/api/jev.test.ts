import { describe, expect, it } from 'vitest';
import {
  interpretPermissionRisk,
  interpretPlanReview,
  interpretSubtaskSizes,
  interpretUrgency,
  parallelPairs,
  planReviewQuestions,
} from './jev';
import type { PlanSubtask } from './plan';

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
      'size_0',
      'clarity_0',
      'size_1',
      'clarity_1',
      'size_2',
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

  it('turns size scores into sizes', () => {
    expect(
      interpretSubtaskSizes(
        {
          size_0: { type: 'score', score: 0.1, probabilities: {}, confidence: 1 },
          size_1: { type: 'score', score: 1.9, probabilities: {}, confidence: 1 },
        },
        3
      )
    ).toEqual(['small', 'large', null]);
  });

  it('accepts a clean plan', () => {
    expect(
      interpretPlanReview({ overlap_0_1: { type: 'noul', noul: 0.2 } }, subtasks.slice(0, 2))
    ).toEqual({ ok: true });
  });
});
