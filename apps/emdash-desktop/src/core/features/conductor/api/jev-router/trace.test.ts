import { describe, expect, it } from 'vitest';
import { answersDetail, layoutBypass, looksLikeSttArtifact, normalizedEntropy } from './trace';

describe('answersDetail', () => {
  it('flattens answers and collapses meta nouls', () => {
    expect(
      answersDetail({
        intent: {
          type: 'choice',
          choice: 'focus',
          confidence: 0.912,
          probabilities: { focus: 0.912, status: 0.05, close: 0.02, next: 0.01 },
        },
        meta_0: { type: 'noul', noul: 0.1 },
        meta_1: { type: 'noul', noul: 0.874 },
        worktree: { type: 'noul', noul: 0.02 },
      })
    ).toEqual({
      jev_intent: 'focus (0.91) | focus=0.91 | status=0.05 | close=0.02',
      jev_worktree: 0.02,
      jev_meta: '0=0.1 1=0.87',
    });
  });
});

describe('normalizedEntropy', () => {
  it('is 0 for a sure answer and 1 for a uniform one', () => {
    expect(normalizedEntropy({ a: 1 })).toBe(0);
    expect(normalizedEntropy({ a: 0.5, b: 0.5 })).toBe(1);
  });
});

describe('layoutBypass', () => {
  it('bypasses short layout talk but not spawns or sends', () => {
    expect(layoutBypass('make the left region bigger', true)).toBe(true);
    expect(layoutBypass('spin up an agent to split the panel layout', true)).toBe(false);
    expect(layoutBypass('tell Maple to resize the panel', true)).toBe(false);
    expect(layoutBypass('make the left region bigger', false)).toBe(false);
  });
});

describe('looksLikeSttArtifact', () => {
  it('catches assistant-style apologies and outros only', () => {
    expect(looksLikeSttArtifact("I'm sorry, but I can't hear any audio.")).toBe(true);
    expect(looksLikeSttArtifact('Thank you for watching!')).toBe(true);
    expect(looksLikeSttArtifact("I'm sorry, focus Maple")).toBe(false);
  });
});
