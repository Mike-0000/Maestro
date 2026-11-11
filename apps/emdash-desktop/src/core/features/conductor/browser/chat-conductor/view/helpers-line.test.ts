import { describe, expect, it } from 'vitest';
import type { LabeledSubAgent } from '../sub-agent-strip';
import { helpersLine } from './helpers-line';

const named = (id: string, label: string): LabeledSubAgent => ({ id, label });
const counted = (id: string): LabeledSubAgent => ({ id, label: 'sub-agent', counted: true });

describe('helpersLine', () => {
  it('is null when none run', () => {
    expect(helpersLine(0)).toBe(null);
    expect(helpersLine([])).toBe(null);
  });

  it('counts sub-agents the host does not name', () => {
    expect(helpersLine(1)).toBe('1 helper');
    expect(helpersLine(3)).toBe('3 helpers');
  });

  it('adds what the first named sub-agent is doing', () => {
    expect(helpersLine([named('a', 'Reading flow4_v2.png')])).toBe(
      '1 helper · Reading flow4_v2.png'
    );
    expect(
      helpersLine([
        named('a', 'Reading flow4_v2.png'),
        named('b', 'Running tests'),
        named('c', 'Searching'),
      ])
    ).toBe('3 helpers · Reading flow4_v2.png');
  });

  it('skips counted and blank entries when picking the label', () => {
    expect(helpersLine([counted('x'), named('a', '  '), named('b', 'Running tests')])).toBe(
      '3 helpers · Running tests'
    );
    expect(helpersLine([counted('x'), counted('y')])).toBe('2 helpers');
  });
});
