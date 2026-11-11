import { describe, expect, it } from 'vitest';
import { DECISION_HEADLINE_CHARS } from '@core/primitives/agents/api/conductor-decisions';
import { conductorDecisionEventSchema, conductorDecisionSchema } from './decisions';

describe('conductor decision schemas', () => {
  it('accepts each decision the renderer can send', () => {
    for (const decision of [
      { kind: 'surface', state: 'needs_you', headline: 'Pick a database', notify: true },
      {
        kind: 'surface',
        state: 'done',
        headline: 'Parser done',
        detail: 'Tests pass.',
        notify: false,
      },
      { kind: 'quiet' },
      { kind: 'quiet', answered: true },
      { kind: 'fallback', reason: 'budget used up' },
    ]) {
      expect(conductorDecisionSchema.parse(decision)).toEqual(decision);
    }
  });

  it('refuses a headline that is empty or too long, and a surface without notify', () => {
    const surface = { kind: 'surface', state: 'done', notify: true };
    expect(conductorDecisionSchema.safeParse({ ...surface, headline: '' }).success).toBe(false);
    expect(
      conductorDecisionSchema.safeParse({
        ...surface,
        headline: 'x'.repeat(DECISION_HEADLINE_CHARS + 1),
      }).success
    ).toBe(false);
    expect(
      conductorDecisionSchema.safeParse({ kind: 'surface', state: 'done', headline: 'Done' })
        .success
    ).toBe(false);
  });

  it('carries a request and its closing on one stream', () => {
    const requested = {
      type: 'requested',
      holdId: 'h1',
      conversationId: 'c1',
      kind: 'awaiting-input',
      notificationType: 'permission_prompt',
      completionReport: null,
      completionSummary: null,
      requestedAt: 1,
      ackBy: 5_001,
      decideBy: 45_001,
    };
    expect(conductorDecisionEventSchema.parse(requested)).toEqual(requested);
    const closed = { type: 'closed', holdId: 'h1', conversationId: 'c1', reason: 'timed-out' };
    expect(conductorDecisionEventSchema.parse(closed)).toEqual(closed);
  });
});
