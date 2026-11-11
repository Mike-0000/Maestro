import { describe, expect, it } from 'vitest';
import type { ChatDigest } from '../../../api/chat-conductor/digest';
import type { ChatConductorEntry } from '../../../api/chat-conductor/thread';
import {
  buildThreadView,
  formatDuration,
  isSpokenLine,
  workLabel,
  type ThreadBlock,
} from './thread-view';

const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1_000).toISOString();

const developer = (id: string, s: number, text = 'do it'): ChatConductorEntry => ({
  kind: 'developer',
  id,
  at: at(s),
  text,
});
const conductor = (id: string, s: number, text = 'On it.'): ChatConductorEntry => ({
  kind: 'conductor',
  id,
  at: at(s),
  text,
});
const action = (
  id: string,
  s: number,
  status: 'done' | 'failed' | 'refused' = 'done'
): ChatConductorEntry => ({
  kind: 'action',
  id,
  at: at(s),
  tool: 'send_to_agent',
  summary: `step ${id}`,
  status,
});
const digest: ChatDigest = {
  outcome: 'finished',
  headline: 'Hang-up: ready to try, not merged.',
  did: ['Fixed `hangUp()`'],
  status: 'Tests pass.',
  next: 'Try it.',
  asked: 'Fix the hang-up.',
  where: 'Branch `fix/hang-up`, not merged.',
  move: 'Try a call.',
};
const digestEntry = (id: string, s: number): ChatConductorEntry => ({
  kind: 'digest',
  id,
  at: at(s),
  digest,
  askedAt: at(0),
});

type Work = Extract<ThreadBlock, { kind: 'work' }>;
const work = (blocks: ThreadBlock[]): Work[] =>
  blocks.filter((block): block is Work => block.kind === 'work');
const emphases = (blocks: ThreadBlock[]) =>
  blocks.flatMap((block) => (block.kind === 'line' ? [[block.id, block.emphasis]] : []));

describe('buildThreadView', () => {
  it('maps each entry kind to its block', () => {
    const blocks = buildThreadView([
      developer('d1', 0),
      { kind: 'event', id: 'e1', at: at(1), text: 'The agent finished a turn' },
      conductor('c1', 2),
      digestEntry('g1', 3),
      { kind: 'error', id: 'x1', at: at(4), text: 'No API key' },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual([
      'developer',
      'event',
      'line',
      'digest',
      'error',
    ]);
    expect(blocks[0]).toEqual({ kind: 'developer', id: 'd1', at: at(0), text: 'do it' });
    expect(blocks[1]).toEqual({
      kind: 'event',
      id: 'e1',
      at: at(1),
      text: 'The agent finished a turn',
    });
    expect(blocks[3]).toMatchObject({ digest, askedAt: at(0), latest: true });
  });

  it('returns no blocks for an empty thread', () => {
    expect(buildThreadView([])).toEqual([]);
  });

  it('folds consecutive actions into one work block, timed from the entry before to the entry after', () => {
    const blocks = buildThreadView([
      developer('d1', 0),
      action('a1', 10),
      action('a2', 20),
      action('a3', 30),
      action('a4', 40),
      conductor('c1', 94),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['developer', 'work', 'line']);
    const [block] = work(blocks);
    expect(block).toMatchObject({
      id: 'work:a1',
      steps: 4,
      durationMs: 94_000,
      failed: 0,
      refused: 0,
      openByDefault: false,
    });
    expect(block!.actions.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('makes separate work blocks for runs split by another entry', () => {
    const blocks = buildThreadView([
      action('a1', 1),
      conductor('c1', 2),
      action('a2', 3),
      action('a3', 4),
    ]);
    expect(work(blocks).map((block) => block.steps)).toEqual([1, 2]);
  });

  it('has no duration when the run starts or ends the thread', () => {
    expect(work(buildThreadView([action('a1', 1), conductor('c1', 5)]))[0]!.durationMs).toBe(null);
    expect(work(buildThreadView([developer('d1', 0), action('a1', 1)]))[0]!.durationMs).toBe(null);
  });

  it('has no duration when a neighbouring time is unreadable or runs backwards', () => {
    const broken: ChatConductorEntry = { kind: 'developer', id: 'd1', at: 'later', text: 'x' };
    expect(
      work(buildThreadView([broken, action('a1', 1), conductor('c1', 5)]))[0]!.durationMs
    ).toBe(null);
    expect(
      work(buildThreadView([developer('d1', 9), action('a1', 1), conductor('c1', 5)]))[0]!
        .durationMs
    ).toBe(null);
  });

  it('counts failed and refused steps and opens the disclosure when any', () => {
    const [refused] = work(
      buildThreadView([developer('d1', 0), action('a1', 1, 'refused'), conductor('c1', 2)])
    );
    expect(refused).toMatchObject({ refused: 1, failed: 0, openByDefault: true });
    const [failed] = work(
      buildThreadView([
        developer('d1', 0),
        action('a1', 1, 'failed'),
        action('a2', 2, 'failed'),
        action('a3', 3),
        conductor('c1', 4),
      ])
    );
    expect(failed).toMatchObject({ refused: 0, failed: 2, steps: 3, openByDefault: true });
  });

  it('gives the last line after the last developer message latest, the two before recent, the rest old', () => {
    const blocks = buildThreadView([
      conductor('c1', 0),
      conductor('c2', 1),
      developer('d1', 2),
      conductor('c3', 3),
      action('a1', 4),
      conductor('c4', 5),
      conductor('c5', 6),
    ]);
    expect(emphases(blocks)).toEqual([
      ['c1', 'old'],
      ['c2', 'old'],
      ['c3', 'recent'],
      ['c4', 'recent'],
      ['c5', 'latest'],
    ]);
  });

  it('counts the two recent lines from before the developer message when they are the nearest', () => {
    const blocks = buildThreadView([
      conductor('c1', 0),
      conductor('c2', 1),
      conductor('c3', 2),
      developer('d1', 3),
      conductor('c4', 4),
    ]);
    expect(emphases(blocks)).toEqual([
      ['c1', 'old'],
      ['c2', 'recent'],
      ['c3', 'recent'],
      ['c4', 'latest'],
    ]);
  });

  it('marks every line old when the developer wrote after the last one', () => {
    const blocks = buildThreadView([conductor('c1', 0), conductor('c2', 1), developer('d1', 2)]);
    expect(emphases(blocks)).toEqual([
      ['c1', 'old'],
      ['c2', 'old'],
    ]);
  });

  it('gives a thread with no developer message a latest line', () => {
    expect(emphases(buildThreadView([conductor('c1', 0)]))).toEqual([['c1', 'latest']]);
  });

  it('flags lines that are not spoken lines as markdown', () => {
    const blocks = buildThreadView([
      conductor('c1', 0, 'Done. The tests pass.'),
      conductor('c2', 1, '## Report\n\n- one\n- two'),
    ]);
    expect(blocks.map((block) => block.kind === 'line' && block.markdown)).toEqual([false, true]);
  });

  it('marks only the last digest latest', () => {
    const blocks = buildThreadView([
      digestEntry('g1', 0),
      conductor('c1', 1),
      digestEntry('g2', 2),
      conductor('c2', 3),
    ]);
    const digests = blocks.flatMap((block) =>
      block.kind === 'digest' ? [[block.id, block.latest]] : []
    );
    expect(digests).toEqual([
      ['g1', false],
      ['g2', true],
    ]);
  });

  it('does not change the entries it was given', () => {
    const entries = [conductor('c1', 0), digestEntry('g1', 1)];
    const copy = structuredClone(entries);
    buildThreadView(entries);
    expect(entries).toEqual(copy);
  });
});

describe('isSpokenLine', () => {
  it('accepts a short plain line, with inline code', () => {
    expect(isSpokenLine('Done. The agent is running the tests.')).toBe(true);
    expect(isSpokenLine('Fixed `hangUp()` in `call.ts`.')).toBe(true);
  });

  it('accepts exactly 280 characters and refuses 281', () => {
    expect(isSpokenLine('a'.repeat(280))).toBe(true);
    expect(isSpokenLine('a'.repeat(281))).toBe(false);
  });

  it('refuses block markdown and several lines', () => {
    for (const text of [
      '# Heading',
      '> quoted',
      '- item',
      '* item',
      '1. first',
      '```ts',
      '| a | b |',
      '---',
      'first line\nsecond line',
    ]) {
      expect(isSpokenLine(text), text).toBe(false);
    }
  });

  it('refuses inline markup plain text would show as punctuation', () => {
    expect(isSpokenLine('See [the PR](https://example.com).')).toBe(false);
    expect(isSpokenLine('This is **important**.')).toBe(false);
  });

  it('refuses an empty line', () => {
    expect(isSpokenLine('   ')).toBe(false);
  });
});

describe('workLabel', () => {
  const block = (patch: Partial<Work>): Work => ({
    kind: 'work',
    id: 'work:a1',
    actions: [],
    steps: 4,
    durationMs: 94_000,
    failed: 0,
    refused: 0,
    openByDefault: false,
    ...patch,
  });

  it('says how long and how many steps', () => {
    expect(workLabel(block({}))).toBe('Worked for 1m 34s · 4 steps');
    expect(workLabel(block({ steps: 1, durationMs: 14_000 }))).toBe('Worked for 14s · 1 step');
  });

  it('adds refused and failed counts', () => {
    expect(workLabel(block({ refused: 1 }))).toBe('Worked for 1m 34s · 4 steps · 1 refused');
    expect(workLabel(block({ refused: 1, failed: 2 }))).toBe(
      'Worked for 1m 34s · 4 steps · 1 refused · 2 failed'
    );
  });

  it('leaves the time out when it is unknown, and says under 1s for less', () => {
    expect(workLabel(block({ durationMs: null }))).toBe('Worked · 4 steps');
    expect(workLabel(block({ durationMs: 400 }))).toBe('Worked for under 1s · 4 steps');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(14_900)).toBe('14s');
    expect(formatDuration(94_000)).toBe('1m 34s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration((2 * 3600 + 5 * 60 + 30) * 1_000)).toBe('2h 5m');
    expect(formatDuration(3 * 3600 * 1_000)).toBe('3h');
  });

  it('never goes below 0s', () => {
    expect(formatDuration(-5_000)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});
