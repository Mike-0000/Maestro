import { describe, expect, it } from 'vitest';
import { asksQuestion, ConversationContext, QUESTION_TTL_MS, REPORTED_TTL_MS } from './context';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const spawn = {
  conversationId: 'h2',
  name: 'Harbor 2',
  providerId: 'codex',
  providerLabel: 'Codex',
  projectName: 'Chorus',
  prompt: 'Fix it',
  taskName: 'Fix it',
  worktree: false,
};

describe('ConversationContext', () => {
  it('tracks the last spawn, send, and which came last', () => {
    const time = clock();
    const context = new ConversationContext(time.now);
    context.noteSpawn(spawn);
    expect(context.snapshot()).toMatchObject({
      lastAction: 'spawn',
      lastAddressed: { name: 'Harbor 2' },
    });
    time.advance(1_000);
    context.noteSend({ conversationId: 't', name: 'Tango', text: 'use Postgres' });
    expect(context.snapshot()).toMatchObject({
      lastAction: 'send',
      lastSpawned: { name: 'Harbor 2' },
      lastSent: { name: 'Tango' },
      lastAddressed: { name: 'Tango' },
    });
  });

  it('expects an answer only shortly after a question', () => {
    const time = clock();
    const context = new ConversationContext(time.now);
    context.noteReply('Which project should the Codex agent work on?');
    expect(context.snapshot().awaitingAnswer).toBe(true);
    time.advance(QUESTION_TTL_MS + 1);
    expect(context.snapshot().awaitingAnswer).toBe(false);
    expect(context.snapshot().lastReply).toContain('Which project');
  });

  it('forgets the reported agent after its window and everything on clear', () => {
    const time = clock();
    const context = new ConversationContext(time.now);
    context.noteReported({ conversationId: 'm', name: 'Maple' });
    context.noteUtterance('open it when done');
    expect(context.snapshot().lastReported?.name).toBe('Maple');
    time.advance(REPORTED_TTL_MS + 1);
    expect(context.snapshot().lastReported).toBeNull();
    context.clear();
    expect(context.snapshot().recentUtterances).toEqual([]);
  });
});

describe('asksQuestion', () => {
  it('detects a trailing question mark', () => {
    expect(asksQuestion('Want me to open it?')).toBe(true);
    expect(asksQuestion('Sent to Tango.')).toBe(false);
  });
});
