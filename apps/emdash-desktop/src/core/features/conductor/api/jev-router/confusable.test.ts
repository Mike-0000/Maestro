import { describe, expect, it } from 'vitest';
import { areConfusable, confusableNames, confusableSplit } from './confusable';

const agent = (name: string) => ({ id: name, name, providerLabel: 'Codex', taskName: 't' });

describe('confusable names', () => {
  it('pairs a name with its numbered twin and near misses', () => {
    expect(areConfusable('Maple', 'Maple 2')).toBe(true);
    expect(areConfusable('Delta 2', 'Delta 3')).toBe(true);
    expect(areConfusable('Harbor', 'Harbour')).toBe(true);
    expect(areConfusable('Maple', 'Tango')).toBe(false);
    expect(areConfusable('Maple', 'Maple')).toBe(false);
  });

  it('maps each name to its confusable neighbours', () => {
    const names = confusableNames(['Maple', 'Maple 2', 'Tango'].map(agent));
    expect(names.get('Maple')).toEqual(['Maple 2']);
    expect(names.has('Tango')).toBe(false);
  });

  it('flags a close split between a confusable pair only', () => {
    const names = confusableNames(['Maple', 'Maple 2', 'Tango'].map(agent));
    expect(confusableSplit({ Maple: 0.5, 'Maple 2': 0.42, Tango: 0.08 }, names)).toEqual([
      'Maple',
      'Maple 2',
    ]);
    expect(confusableSplit({ Maple: 0.85, 'Maple 2': 0.1 }, names)).toBeNull();
    expect(confusableSplit({ Maple: 0.5, Tango: 0.45 }, names)).toBeNull();
  });
});
