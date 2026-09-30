import { z } from 'zod';
import type { PlanSubtask } from './plan';

/**
 * Jev (TypeSafe AI's "System One" model) makes the conductor's fast, typed decisions: routing an
 * utterance, rating the risk of a permission prompt, ranking which agent needs the user most, and
 * sanity-checking plans. One request answers several questions in parallel (~50 ms) with
 * calibrated probabilities, so the conductor acts only when Jev is confident and falls back to
 * Claude (or asks) otherwise.
 *
 * API: POST https://api.typesafe.ai/v1/systemone — https://docs.typesafe.ai/api
 */

export const JEV_MODEL = 'jev-latest';
/** The same model through OpenRouter (alias that tracks the newest Jev release). */
export const JEV_OPENROUTER_MODEL = '~typesafe/jev-latest';

export type JevRubric = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: 'noul'; instructions: JevRubric; criteria?: { true?: JevRubric; false?: JevRubric } }
  | { type: 'choice'; instructions: JevRubric; criteria: Record<string, JevRubric | null> }
  | { type: 'score'; instructions: JevRubric; criteria: JevRubric[] };

export type JevQuestions = Record<string, JevQuestion>;

export const jevAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
]);
export type JevAnswer = z.infer<typeof jevAnswerSchema>;
export type JevAnswers = Record<string, JevAnswer>;

export const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number(), cost: z.number() })
    .partial()
    .optional(),
});

/** Choice/Score limits from the API reference. */
export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MAX_SCORE_LEVELS = 10;

export function choiceOf(answers: JevAnswers, id: string) {
  const answer = answers[id];
  return answer?.type === 'choice' ? answer : null;
}

export function noulOf(answers: JevAnswers, id: string): number | null {
  const answer = answers[id];
  return answer?.type === 'noul' ? answer.noul : null;
}

export function scoreOf(answers: JevAnswers, id: string) {
  const answer = answers[id];
  return answer?.type === 'score' ? answer : null;
}

// ── Permission risk ───────────────────────────────────────────────────────────

export const RISK_LEVELS = [
  'Read-only or clearly harmless (reading files, listing, searching, running tests)',
  'Edits files inside the project workspace',
  'Side effects beyond the workspace (installs packages, network calls, git commit or push)',
  'Destructive or irreversible (deletes files or data, force push, touches credentials or system settings)',
] as const;

export type RiskLevel = 'low' | 'moderate' | 'elevated' | 'high';
const RISK_NAMES: RiskLevel[] = ['low', 'moderate', 'elevated', 'high'];

export function permissionRiskQuestions(): JevQuestions {
  return {
    risk: {
      type: 'score',
      instructions:
        'The `terminal` shows a coding agent asking permission to run an action. How risky is approving it?',
      criteria: [...RISK_LEVELS],
    },
    is_prompt: {
      type: 'noul',
      instructions:
        'Is the agent in `terminal` currently waiting for the user to approve or deny an action?',
    },
  };
}

export type PermissionRisk = { level: RiskLevel; score: number; confidence: number };

export function interpretPermissionRisk(answers: JevAnswers): PermissionRisk | null {
  const risk = scoreOf(answers, 'risk');
  if (!risk) return null;
  const index = Math.max(0, Math.min(RISK_NAMES.length - 1, Math.round(risk.score)));
  return { level: RISK_NAMES[index] ?? 'moderate', score: risk.score, confidence: risk.confidence };
}

// ── Attention urgency ─────────────────────────────────────────────────────────

export const URGENCY_LEVELS = [
  'Finished or idle; can wait',
  'Asking a routine question or for a routine approval',
  'Blocked on the user for a decision it cannot make alone',
  'Failing, looping, or about to do something harmful; needs the user now',
] as const;

export function urgencyQuestions(): JevQuestions {
  return {
    urgency: {
      type: 'score',
      instructions: 'How urgently does the coding agent in `terminal` need the developer?',
      criteria: [...URGENCY_LEVELS],
    },
  };
}

/** Urgency on a 0–1 scale, or null when Jev did not answer. */
export function interpretUrgency(answers: JevAnswers): number | null {
  const urgency = scoreOf(answers, 'urgency');
  return urgency ? urgency.score / (URGENCY_LEVELS.length - 1) : null;
}

// ── Plan review ───────────────────────────────────────────────────────────────

/** Parallel pairs worth checking (subtasks ordered by sequential_after never run together). */
export function parallelPairs(subtasks: readonly PlanSubtask[]): [number, number][] {
  const pairs: [number, number][] = [];
  const after = (a: PlanSubtask, b: PlanSubtask): boolean => {
    const seen = new Set<string>();
    let current: string | undefined = a.sequential_after;
    while (current && !seen.has(current)) {
      if (current === b.title) return true;
      seen.add(current);
      current = subtasks.find((subtask) => subtask.title === current)?.sequential_after;
    }
    return false;
  };
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const a = subtasks[i];
      const b = subtasks[j];
      if (a && b && !after(a, b) && !after(b, a)) pairs.push([i, j]);
    }
  }
  return pairs;
}

export const CLARITY_LEVELS = [
  'Vague; an agent would have to guess what to build',
  'Clear goal but missing where or how',
  'Clear, scoped, and actionable on its own',
] as const;

export const SIZE_LEVELS = [
  'Small: a focused change to a few files',
  'Medium: a feature slice across several files with tests',
  'Large: a broad change across many files or subsystems',
] as const;

export type SubtaskSize = 'small' | 'medium' | 'large';
const SIZE_NAMES: SubtaskSize[] = ['small', 'medium', 'large'];

/** Rough agent token use per size, for a before-approval cost readout (order of magnitude). */
export const SIZE_TOKEN_RANGE: Record<SubtaskSize, [number, number]> = {
  small: [200_000, 1_000_000],
  medium: [1_000_000, 4_000_000],
  large: [4_000_000, 12_000_000],
};

export function interpretSubtaskSizes(answers: JevAnswers, count: number): (SubtaskSize | null)[] {
  return Array.from({ length: count }, (_unused, index) => {
    const size = scoreOf(answers, `size_${index}`);
    if (!size) return null;
    return SIZE_NAMES[Math.max(0, Math.min(2, Math.round(size.score)))] ?? null;
  });
}

export function planReviewQuestions(subtasks: readonly PlanSubtask[]): JevQuestions {
  const questions: JevQuestions = {};
  subtasks.forEach((_subtask, index) => {
    questions[`size_${index}`] = {
      type: 'score',
      instructions: `How much work is \`subtasks[${index}]\` for a coding agent?`,
      criteria: [...SIZE_LEVELS],
    };
    questions[`clarity_${index}`] = {
      type: 'score',
      instructions: `How well can an agent work on \`subtasks[${index}]\` alone, from its prompt only?`,
      criteria: [...CLARITY_LEVELS],
    };
  });
  for (const [i, j] of parallelPairs(subtasks)) {
    questions[`overlap_${i}_${j}`] = {
      type: 'noul',
      instructions: `Running at the same time in separate git branches, would \`subtasks[${i}]\` and \`subtasks[${j}]\` probably need to edit the same files or duplicate the same work?`,
    };
  }
  return questions;
}

export function planReviewState(goal: string, subtasks: readonly PlanSubtask[]) {
  return {
    goal,
    subtasks: subtasks.map((subtask) => ({
      title: subtask.title,
      prompt: subtask.prompt,
      owned_paths: subtask.owned_paths,
    })),
  };
}

export type PlanReview = { ok: true } | { ok: false; reason: string };

/** Rejects plans Jev is fairly sure would collide or leave an agent guessing. */
export function interpretPlanReview(
  answers: JevAnswers,
  subtasks: readonly PlanSubtask[],
  options: { overlapThreshold?: number } = {}
): PlanReview {
  const overlapThreshold = options.overlapThreshold ?? 0.75;
  const problems: string[] = [];
  for (const [i, j] of parallelPairs(subtasks)) {
    const overlap = noulOf(answers, `overlap_${i}_${j}`);
    if (overlap !== null && overlap >= overlapThreshold) {
      problems.push(
        `"${subtasks[i]?.title}" and "${subtasks[j]?.title}" would likely edit the same code (${Math.round(overlap * 100)}%)`
      );
    }
  }
  subtasks.forEach((subtask, index) => {
    const clarity = scoreOf(answers, `clarity_${index}`);
    if (clarity && clarity.score < 0.75 && clarity.confidence >= 0.5) {
      problems.push(`"${subtask.title}" is too vague to work on alone`);
    }
  });
  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Plan review: ${problems.join('; ')}. Merge overlapping subtasks, make one sequential_after the other, or make prompts more specific, then propose again.`,
  };
}
