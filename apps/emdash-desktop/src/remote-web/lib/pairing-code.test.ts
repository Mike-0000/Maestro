import { describe, expect, it } from 'vitest';
import { formatPairingCode, isCompletePairingCode, normalizePairingCode } from './pairing-code';

describe('pairing code', () => {
  it('accepts the code with or without the dash, in any case', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCDEFGH')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ab cd – ef gh ')).toBe('ABCDEFGH');
  });

  it('caps pasted text at the code length', () => {
    expect(normalizePairingCode('ABCD-EFGH-JKMN')).toBe('ABCDEFGH');
  });

  it('formats partial and complete codes for display', () => {
    expect(formatPairingCode('')).toBe('');
    expect(formatPairingCode('abc')).toBe('ABC');
    expect(formatPairingCode('abcd')).toBe('ABCD');
    expect(formatPairingCode('abcde')).toBe('ABCD-E');
    expect(formatPairingCode('abcd-efgh')).toBe('ABCD-EFGH');
  });

  it('knows when a code is complete', () => {
    expect(isCompletePairingCode('ABCD-EFG')).toBe(false);
    expect(isCompletePairingCode('abcd efgh')).toBe(true);
  });
});
