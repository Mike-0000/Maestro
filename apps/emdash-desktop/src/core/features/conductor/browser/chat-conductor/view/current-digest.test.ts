import { describe, expect, it } from 'vitest';
import type { ChatDigest } from '../../../api/chat-conductor/digest';
import type { ChatConductorEntry } from '../../../api/chat-conductor/thread';
import { currentDigestId } from './current-digest';
import { buildThreadView } from './thread-view';

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 10, 12) + seconds * 1_000).toISOString();

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

const developer = (id: string, s: number): ChatConductorEntry => ({
  kind: 'developer',
  id,
  at: at(s),
  text: 'do it',
});
const conductor = (id: string, s: number): ChatConductorEntry => ({
  kind: 'conductor',
  id,
  at: at(s),
  text: 'On it.',
});
const report = (id: string, s: number): ChatConductorEntry => ({
  kind: 'digest',
  id,
  at: at(s),
  digest,
  askedAt: null,
});
const event = (id: string, s: number): ChatConductorEntry => ({
  kind: 'event',
  id,
  at: at(s),
  text: 'The agent finished a turn',
});

const current = (entries: ChatConductorEntry[]) => currentDigestId(buildThreadView(entries));

describe('currentDigestId', () => {
  it('is the newest digest when nothing the developer wrote follows it', () => {
    expect(current([developer('d1', 0), report('r1', 10)])).toBe('r1');
    expect(current([developer('d1', 0), report('r1', 10), conductor('c1', 11)])).toBe('r1');
    expect(current([report('r1', 10), event('e1', 20), conductor('c1', 21)])).toBe('r1');
  });

  it('is only ever the newest of several digests', () => {
    expect(current([report('r1', 0), conductor('c1', 1), report('r2', 2)])).toBe('r2');
  });

  it('is null once the developer wrote after the digest', () => {
    expect(current([report('r1', 0), developer('d1', 5)])).toBeNull();
    expect(current([report('r1', 0), developer('d1', 5), conductor('c1', 6)])).toBeNull();
  });

  it('is null in a thread without digests', () => {
    expect(current([])).toBeNull();
    expect(current([developer('d1', 0), conductor('c1', 1)])).toBeNull();
  });
});
