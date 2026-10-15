import { describe, expect, it } from 'vitest';
import { matchInstalledProvider } from './provider-match';

const providers = [
  { id: 'claude', name: 'Claude Code', extra: 1 },
  { id: 'codex', name: 'Codex' },
];

describe('matchInstalledProvider', () => {
  it('matches an id or display name in any case', () => {
    expect(matchInstalledProvider('claude', providers)?.id).toBe('claude');
    expect(matchInstalledProvider('Claude', providers)?.id).toBe('claude');
    expect(matchInstalledProvider(' CLAUDE CODE ', providers)?.id).toBe('claude');
    expect(matchInstalledProvider('Codex CLI', providers)?.id).toBe('codex');
  });

  it('returns the matched entry itself, keeping its other fields', () => {
    expect(matchInstalledProvider('Claude', providers)).toBe(providers[0]);
  });

  it('matches nothing for an unknown or empty reference', () => {
    expect(matchInstalledProvider('Gemini', providers)).toBeNull();
    expect(matchInstalledProvider('  ', providers)).toBeNull();
  });
});
