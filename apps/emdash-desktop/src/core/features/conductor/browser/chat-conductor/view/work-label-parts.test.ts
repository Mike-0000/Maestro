import { describe, expect, it } from 'vitest';
import { workLabel, type ThreadBlock } from './thread-view';
import { workLabelParts } from './work-label-parts';

type Work = Extract<ThreadBlock, { kind: 'work' }>;

const block = (patch: Partial<Work>): Work => ({
  kind: 'work',
  id: 'work:a',
  actions: [],
  steps: 4,
  durationMs: 94_000,
  failed: 0,
  refused: 0,
  openByDefault: false,
  ...patch,
});

const joined = (work: Work) =>
  workLabelParts(work)
    .map((part) => part.text)
    .join(' · ');

describe('workLabelParts', () => {
  it('is one plain part when every step went through', () => {
    expect(workLabelParts(block({}))).toEqual([
      { text: 'Worked for 1m 34s · 4 steps', tone: 'plain' },
    ]);
  });

  it('gives refused steps the warning tone and failed ones the error tone', () => {
    expect(workLabelParts(block({ refused: 1, failed: 2 }))).toEqual([
      { text: 'Worked for 1m 34s · 4 steps', tone: 'plain' },
      { text: '1 refused', tone: 'warning' },
      { text: '2 failed', tone: 'error' },
    ]);
    expect(workLabelParts(block({ failed: 1, durationMs: null, steps: 1 }))).toEqual([
      { text: 'Worked · 1 step', tone: 'plain' },
      { text: '1 failed', tone: 'error' },
    ]);
  });

  it('reads exactly as workLabel when joined', () => {
    for (const work of [
      block({}),
      block({ refused: 3 }),
      block({ failed: 1, refused: 1, durationMs: 500 }),
      block({ durationMs: null, steps: 1 }),
    ]) {
      expect(joined(work)).toBe(workLabel(work));
    }
  });
});
