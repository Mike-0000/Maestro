import { describe, expect, it } from 'vitest';
import { editDistance, normalizeSpoken, resolveAgent, type RosterAgent } from './resolver';

const roster: RosterAgent[] = [
  { id: 'c1', name: 'Claude 1', providerLabel: 'Claude', taskName: 'auth-refactor' },
  { id: 'c2', name: 'Claude 2', providerLabel: 'Claude', taskName: 'settings-page' },
  { id: 'x1', name: 'Codex 1', providerLabel: 'Codex', taskName: 'api tests' },
];

describe('normalizeSpoken', () => {
  it('maps number words, homophones, and misheard providers', () => {
    expect(normalizeSpoken('Clod Two')).toBe('claude 2');
    expect(normalizeSpoken('the codecs one')).toBe('codex');
    expect(normalizeSpoken('Claude-2!')).toBe('claude 2');
  });
});

describe('resolveAgent', () => {
  it('matches exact spoken names', () => {
    expect(resolveAgent('Claude two', roster, null)).toMatchObject({
      kind: 'match',
      agent: { id: 'c2' },
    });
  });

  it('resolves a unique provider, and asks when a provider is shared', () => {
    expect(resolveAgent('codex', roster, null)).toMatchObject({
      kind: 'match',
      agent: { id: 'x1' },
    });
    expect(resolveAgent('claude', roster, null).kind).toBe('ambiguous');
  });

  it('resolves deictic references to the focused agent only', () => {
    expect(resolveAgent('this one', roster, 'c1')).toMatchObject({ agent: { id: 'c1' } });
    expect(resolveAgent('this one', roster, null).kind).toBe('none');
  });

  it('resolves by task name', () => {
    expect(resolveAgent('the settings agent', roster, null)).toMatchObject({
      agent: { id: 'c2' },
    });
    expect(resolveAgent('api tests', roster, null)).toMatchObject({ agent: { id: 'x1' } });
  });

  it('never fuzzes numbers', () => {
    const single = [roster[0] as RosterAgent];
    expect(resolveAgent('Claude 2', single, null).kind).toBe('none');
    expect(resolveAgent('Claude 3', roster, null).kind).toBe('none');
  });

  it('tolerates small misspellings of full names', () => {
    expect(resolveAgent('Claud 1', roster, null)).toMatchObject({ agent: { id: 'c1' } });
    expect(resolveAgent('Kodex 1', roster, null)).toMatchObject({ agent: { id: 'x1' } });
  });

  it('returns none for unrelated words', () => {
    expect(resolveAgent('banana', roster, null).kind).toBe('none');
  });
});

describe('editDistance', () => {
  it('computes Levenshtein distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });
});
