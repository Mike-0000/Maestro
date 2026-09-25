import { describe, expect, it } from 'vitest';
import {
  editDistance,
  isDeictic,
  normalizeSpoken,
  phoneticKey,
  resolveAgent,
  type RosterAgent,
} from './resolver';

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

describe('roster names', () => {
  const named: RosterAgent[] = [
    { id: 'a', name: 'Atlas', providerLabel: 'Claude', taskName: 'auth' },
    { id: 'b', name: 'Bravo', providerLabel: 'Codex', taskName: 'api-tests' },
    { id: 'c', name: 'Cedar', providerLabel: 'Codex', taskName: 'docs', hidden: true },
  ];

  it('matches misheard names by sound', () => {
    expect(phoneticKey('at less')).toBe(phoneticKey('Atlas'));
    expect(resolveAgent('at less', named, null)).toMatchObject({ agent: { id: 'a' } });
    expect(resolveAgent('brave oh', named, null)).toMatchObject({ agent: { id: 'b' } });
  });

  it('strips window nouns and possessives', () => {
    expect(normalizeSpoken("Atlas's window")).toBe('atlas');
    expect(resolveAgent('the bravo terminal', named, null)).toMatchObject({ agent: { id: 'b' } });
  });

  it('prefers visible agents but still finds closed ones', () => {
    // "codex" would be ambiguous if the closed Cedar counted.
    expect(resolveAgent('codex', named, null)).toMatchObject({ agent: { id: 'b' } });
    expect(resolveAgent('cedar', named, null)).toMatchObject({ agent: { id: 'c' } });
  });

  it('resolves deictic references to the focused agent', () => {
    expect(isDeictic('this one')).toBe(true);
    expect(isDeictic('that window')).toBe(true);
    expect(isDeictic('atlas')).toBe(false);
    expect(resolveAgent('this one', named, 'b')).toMatchObject({ agent: { id: 'b' } });
    expect(resolveAgent('this one', named, null).kind).toBe('none');
  });

  it('does not match short or unrelated words by sound', () => {
    expect(resolveAgent('at', named, null).kind).toBe('none');
    expect(resolveAgent('brief', named, null).kind).toBe('none');
  });
});
