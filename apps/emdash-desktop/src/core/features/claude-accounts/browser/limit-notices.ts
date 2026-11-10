import type { ClaudeAccountsEvent } from '../api/types';

/** The account events that can raise a toast: moves and limits that stayed put. */
export type LimitNoticeEvent = Extract<
  ClaudeAccountsEvent,
  { type: 'conversation-moved' } | { type: 'limit-unhandled' }
>;

export type LimitNoticeTone = 'neutral' | 'warning' | 'error';

/** One toast. Raising it again with the same `id` updates it in place. */
export type LimitNotice = {
  id: string;
  tone: LimitNoticeTone;
  title: string;
  description?: string;
};

export type LimitNoticeContext = {
  /** An account's name; something readable even when the account is gone. */
  accountLabel: (accountId: string) => string;
  /** The conversation's title, or null when it is not known here. */
  conversationTitle: (event: LimitNoticeEvent) => string | null;
};

/** Events of one kind arriving closer together than this share one toast. */
export const LIMIT_NOTICE_BURST_MS = 2_000;

/**
 * Which toast an event belongs to, or null when it raises none: a manual move (the action that
 * asked for it reports it) and a conversation still cooling down from its last automatic move.
 */
export function limitNoticeKey(event: LimitNoticeEvent): string | null {
  if (event.type === 'conversation-moved') {
    if (event.reason !== 'limit') return null;
    return `moved:${event.fromAccountId}:${event.toAccountId}`;
  }
  if (event.reason === 'cooldown') return null;
  return `${event.reason}:${event.accountId}`;
}

/**
 * The wording for `count` events of the same kind; `event` is the latest of them. One event
 * names its conversation ("A conversation" when the title is unknown); several are counted.
 * Null for a conversation cooling down from its last automatic move, which raises no toast.
 */
export function limitNoticeText(
  event: LimitNoticeEvent,
  count: number,
  context: LimitNoticeContext
): Omit<LimitNotice, 'id'> | null {
  const many = count > 1;
  const subject = many
    ? `${count} conversations hit their usage limit`
    : `${context.conversationTitle(event) ?? 'A conversation'} hit its usage limit`;

  if (event.type === 'conversation-moved') {
    const from = context.accountLabel(event.fromAccountId);
    const to = context.accountLabel(event.toAccountId);
    return { tone: 'neutral', title: `${subject} on ${from} and continued on ${to}.` };
  }

  const account = context.accountLabel(event.accountId);
  const hit = `${subject} on ${account}.`;
  switch (event.reason) {
    case 'no-eligible-account':
      return { tone: 'warning', title: `${hit} No other account has usage left.` };
    case 'burst-cap':
      return {
        tone: 'warning',
        title: `${hit} Too many conversations moved at once; ${many ? 'they stay' : 'it stays'} on ${account}.`,
      };
    case 'cooldown':
      return null;
    case 'move-failed':
      return {
        tone: 'error',
        title: `${hit} Couldn't continue ${many ? 'them' : 'it'} on another account.`,
        ...(event.message ? { description: event.message } : {}),
      };
  }
}

type Burst = { id: string; count: number; lastAt: number };

/**
 * Turns the account event stream into toasts. Events of the same kind that follow each other
 * within {@link LIMIT_NOTICE_BURST_MS} update one toast with a count instead of stacking.
 */
export class LimitNoticeCoalescer {
  private readonly bursts = new Map<string, Burst>();
  private sequence = 0;

  constructor(
    private readonly now: () => number,
    private readonly burstMs: number = LIMIT_NOTICE_BURST_MS
  ) {}

  /** The toast to raise for this event, or null when it raises none. */
  add(event: LimitNoticeEvent, context: LimitNoticeContext): LimitNotice | null {
    const key = limitNoticeKey(event);
    if (key === null) return null;
    const now = this.now();
    for (const [candidate, burst] of this.bursts) {
      if (now - burst.lastAt > this.burstMs) this.bursts.delete(candidate);
    }
    const existing = this.bursts.get(key);
    const burst: Burst = existing
      ? { ...existing, count: existing.count + 1, lastAt: now }
      : { id: `claude-limit:${key}:${++this.sequence}`, count: 1, lastAt: now };
    const text = limitNoticeText(event, burst.count, context);
    if (!text) return null;
    this.bursts.set(key, burst);
    return { id: burst.id, ...text };
  }
}
