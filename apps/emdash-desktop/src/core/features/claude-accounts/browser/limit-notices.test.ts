import { describe, expect, it } from 'vitest';
import {
  LIMIT_NOTICE_BURST_MS,
  LimitNoticeCoalescer,
  limitNoticeKey,
  limitNoticeText,
  type LimitNoticeContext,
  type LimitNoticeEvent,
} from './limit-notices';

const labels: Record<string, string> = { primary: 'Personal', work: 'Work', team: 'Team' };

const context: LimitNoticeContext = {
  accountLabel: (accountId) => labels[accountId] ?? 'another account',
  conversationTitle: (event) => (event.conversationId === 'c1' ? 'Fix login' : null),
};

function moved(
  conversationId = 'c1',
  reason: 'manual' | 'limit' = 'limit',
  fromAccountId = 'work',
  toAccountId = 'primary'
): LimitNoticeEvent {
  return {
    type: 'conversation-moved',
    conversationId,
    projectId: 'p',
    taskId: 't',
    fromAccountId,
    toAccountId,
    reason,
  };
}

function unhandled(
  reason: 'no-eligible-account' | 'burst-cap' | 'cooldown' | 'move-failed',
  conversationId = 'c1',
  message?: string
): LimitNoticeEvent {
  return {
    type: 'limit-unhandled',
    conversationId,
    projectId: 'p',
    taskId: 't',
    accountId: 'work',
    reason,
    ...(message ? { message } : {}),
  };
}

describe('limitNoticeText', () => {
  it('names one conversation that moved at its limit', () => {
    expect(limitNoticeText(moved(), 1, context)).toEqual({
      tone: 'neutral',
      title: 'Fix login hit its usage limit on Work and continued on Personal.',
    });
  });

  it('says "A conversation" when the title is unknown', () => {
    expect(limitNoticeText(moved('c2'), 1, context)?.title).toBe(
      'A conversation hit its usage limit on Work and continued on Personal.'
    );
  });

  it('counts several conversations', () => {
    expect(limitNoticeText(moved('c2'), 3, context)?.title).toBe(
      '3 conversations hit their usage limit on Work and continued on Personal.'
    );
  });

  it('words each reason a conversation stayed put', () => {
    expect(limitNoticeText(unhandled('no-eligible-account'), 1, context)).toEqual({
      tone: 'warning',
      title: 'Fix login hit its usage limit on Work. No other account has usage left.',
    });
    expect(limitNoticeText(unhandled('burst-cap'), 1, context)?.title).toBe(
      'Fix login hit its usage limit on Work. Too many conversations moved at once; it stays on Work.'
    );
    expect(limitNoticeText(unhandled('burst-cap'), 2, context)?.title).toBe(
      '2 conversations hit their usage limit on Work. Too many conversations moved at once; they stay on Work.'
    );
    expect(
      limitNoticeText(unhandled('move-failed', 'c1', 'Session not found'), 1, context)
    ).toEqual({
      tone: 'error',
      title: "Fix login hit its usage limit on Work. Couldn't continue it on another account.",
      description: 'Session not found',
    });
    expect(limitNoticeText(unhandled('cooldown'), 1, context)).toBeNull();
  });
});

describe('limitNoticeKey', () => {
  it('raises nothing for manual moves and cooldowns', () => {
    expect(limitNoticeKey(moved('c1', 'manual'))).toBeNull();
    expect(limitNoticeKey(unhandled('cooldown'))).toBeNull();
  });

  it('groups by kind and accounts', () => {
    expect(limitNoticeKey(moved('c1'))).toBe(limitNoticeKey(moved('c2')));
    expect(limitNoticeKey(moved('c1'))).not.toBe(
      limitNoticeKey(moved('c1', 'limit', 'work', 'team'))
    );
    expect(limitNoticeKey(unhandled('burst-cap'))).not.toBe(
      limitNoticeKey(unhandled('no-eligible-account'))
    );
  });
});

describe('LimitNoticeCoalescer', () => {
  function harness() {
    let now = 1_000;
    const coalescer = new LimitNoticeCoalescer(() => now);
    return {
      add: (event: LimitNoticeEvent) => coalescer.add(event, context),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('updates one toast with a count for a burst of the same kind', () => {
    const { add, advance } = harness();
    const first = add(moved('c1'));
    advance(500);
    const second = add(moved('c2'));
    advance(1_500);
    const third = add(moved('c3'));

    expect(first?.title).toBe('Fix login hit its usage limit on Work and continued on Personal.');
    expect(second?.id).toBe(first?.id);
    expect(third?.id).toBe(first?.id);
    expect(third?.title).toBe(
      '3 conversations hit their usage limit on Work and continued on Personal.'
    );
  });

  it('starts a new toast once the burst is over', () => {
    const { add, advance } = harness();
    const first = add(moved('c1'));
    advance(LIMIT_NOTICE_BURST_MS + 1);
    const second = add(moved('c2'));

    expect(second?.id).not.toBe(first?.id);
    expect(second?.title).toBe(
      'A conversation hit its usage limit on Work and continued on Personal.'
    );
  });

  it('keeps different kinds apart and skips events that raise nothing', () => {
    const { add } = harness();
    const movedNotice = add(moved('c1'));
    const capped = add(unhandled('burst-cap', 'c2'));

    expect(capped?.id).not.toBe(movedNotice?.id);
    expect(capped?.title).toContain('A conversation hit its usage limit on Work.');
    expect(add(moved('c3', 'manual'))).toBeNull();
    expect(add(unhandled('cooldown'))).toBeNull();
  });
});
