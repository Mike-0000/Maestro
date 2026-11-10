import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@core/primitives/agents/api';
import type { ClaudeAccount, ClaudeAccountUsage, ClaudeAccountsEvent } from '../api/types';
import {
  AUTO_MOVE_COOLDOWN_MS,
  ClaudeLimitSwitchService,
  FORCED_USAGE_REUSE_MS,
  LIMIT_FOLLOW_UP_PROMPT,
  type LimitSwitchConversation,
} from './limit-switch-service';

const LIMIT_SCREEN =
  "\u001b[31m⎿  You've hit your limit · resets 3am (Europe/Berlin)\u001b[39m\r\n> ";
const LIMIT_REPLY = "You've hit your limit · resets 3am (Europe/Berlin)";
const START = Date.parse('2026-11-10T12:00:00.000Z');

function account(id: string, loggedIn = true): ClaudeAccount {
  return { id, label: id, kind: id === 'primary' ? 'primary' : 'extra', loggedIn };
}

type Figures = { five: number | null; week: number | null; resetsAt?: string | null };

function fresh(accountId: string, figures: Figures): ClaudeAccountUsage {
  const window = (value: number | null) =>
    value === null ? null : { usedPercent: value, resetsAt: figures.resetsAt ?? null };
  return {
    accountId,
    status: 'fresh',
    snapshot: {
      fetchedAt: new Date(START).toISOString(),
      subscriptionType: 'max',
      fiveHour: window(figures.five),
      sevenDay: window(figures.week),
      sevenDayOpus: null,
      sevenDaySonnet: null,
      limits: [],
    },
  };
}

function setup(
  options: {
    accounts?: ClaudeAccount[];
    usage?: Record<string, Figures | 'unavailable' | 'stale'>;
    enabled?: boolean;
    conversations?: LimitSwitchConversation[];
  } = {}
) {
  let now = START;
  let accounts = options.accounts ?? [account('primary'), account('work'), account('spare')];
  let figures: Record<string, Figures | 'unavailable' | 'stale'> = options.usage ?? {
    primary: { five: 100, week: 40, resetsAt: '2026-11-10T15:00:00.000Z' },
    work: { five: 20, week: 30 },
    spare: { five: 50, week: 10 },
  };
  const conversations = new Map(
    (
      options.conversations ?? [
        { conversationId: 'c1', projectId: 'p1', taskId: 't1', type: 'pty', accountId: 'primary' },
      ]
    ).map((conversation) => [conversation.conversationId, conversation])
  );
  const screens = new Map<string, string>();
  const replies = new Map<string, string>();
  const events: ClaudeAccountsEvent[] = [];
  const usage = vi.fn(async () =>
    accounts.map((entry): ClaudeAccountUsage => {
      const value = figures[entry.id] ?? 'unavailable';
      if (value === 'unavailable') {
        return { accountId: entry.id, status: 'unavailable', snapshot: null, reason: 'network' };
      }
      if (value === 'stale') {
        return {
          ...fresh(entry.id, { five: 0, week: 0 }),
          status: 'stale',
          reason: 'rate-limited',
        };
      }
      return fresh(entry.id, value);
    })
  );
  const move = vi.fn(
    async (input: { conversationId: string; accountId: string }) =>
      ok(input) as ReturnType<typeof ok<unknown>> | ReturnType<typeof err<{ type: string }>>
  );
  const terminalTail = vi.fn(async (id: string) => screens.get(id) ?? null);
  const lastChatReply = vi.fn(async (id: string) => replies.get(id) ?? null);
  const service = new ClaudeLimitSwitchService({
    enabled: async () => options.enabled ?? true,
    accounts: async () => ({ accounts, defaultAccountId: 'primary' }),
    usage,
    describe: async (id) => conversations.get(id) ?? null,
    terminalTail,
    lastChatReply,
    move: (input) => move(input),
    emit: (event) => events.push(event),
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => now,
  });

  const event = (
    conversationId: string,
    type: AgentEvent['type'],
    payload: AgentEvent['payload'] = {},
    providerId = 'claude'
  ): AgentEvent => ({
    type,
    providerId,
    conversationId,
    projectId: 'p1',
    taskId: 't1',
    timestamp: now,
    payload,
  });

  return {
    service,
    usage,
    move,
    events,
    terminalTail,
    lastChatReply,
    conversations,
    advance: (ms: number) => (now += ms),
    setAccounts: (next: ClaudeAccount[]) => (accounts = next),
    setUsage: (next: typeof figures) => (figures = next),
    showOnScreen: (id: string, text: string) => screens.set(id, text),
    replyWith: (id: string, text: string) => replies.set(id, text),
    send: (...args: Parameters<typeof event>) => service.handleAgentEvent(event(...args)),
    /** A terminal turn that runs into the limit: started, then the idle reminder. */
    async terminalLimit(id = 'c1') {
      screens.set(id, LIMIT_SCREEN);
      service.handleAgentEvent(event(id, 'start'));
      service.handleAgentEvent(event(id, 'notification', { notificationType: 'idle_prompt' }));
      await service.idle();
    },
  };
}

describe('ClaudeLimitSwitchService', () => {
  describe('detection', () => {
    it('moves a working terminal conversation that shows the limit and is at its limit', async () => {
      const harness = setup();

      await harness.terminalLimit();

      expect(harness.usage).toHaveBeenCalledWith({ force: true });
      expect(harness.move).toHaveBeenCalledWith({
        conversationId: 'c1',
        accountId: 'work',
        followUpPrompt: LIMIT_FOLLOW_UP_PROMPT,
        reason: 'limit',
      });
      expect(harness.events).toEqual([]);
    });

    it('takes the limit message from a stop that carries it, without reading the screen', async () => {
      const harness = setup();

      harness.send('c1', 'start');
      harness.send('c1', 'stop', { lastAssistantMessage: LIMIT_REPLY });
      await harness.service.idle();

      expect(harness.terminalTail).not.toHaveBeenCalled();
      expect(harness.move).toHaveBeenCalledTimes(1);
    });

    it('moves a chat conversation whose failed turn ended with the limit message', async () => {
      const harness = setup({
        conversations: [
          {
            conversationId: 'c1',
            projectId: 'p1',
            taskId: 't1',
            type: 'acp',
            accountId: 'primary',
          },
        ],
      });
      harness.replyWith('c1', LIMIT_REPLY);

      harness.send('c1', 'start');
      harness.send('c1', 'error');
      await harness.service.idle();

      expect(harness.lastChatReply).toHaveBeenCalledWith('c1');
      expect(harness.move).toHaveBeenCalledTimes(1);
    });

    it('ignores an ordinary stop: no limit message on screen, usage never asked', async () => {
      const harness = setup();
      harness.showOnScreen('c1', '● All tests pass.\r\n> ');

      harness.send('c1', 'start');
      harness.send('c1', 'stop', { lastAssistantMessage: 'All tests pass.' });
      await harness.service.idle();

      expect(harness.terminalTail).toHaveBeenCalledWith('c1');
      expect(harness.usage).not.toHaveBeenCalled();
      expect(harness.move).not.toHaveBeenCalled();
    });

    it('reads the screen on a terminal stop that carries no limit text', async () => {
      const harness = setup();
      harness.showOnScreen('c1', LIMIT_SCREEN);

      harness.send('c1', 'start');
      harness.send('c1', 'stop', { lastAssistantMessage: '' });
      await harness.service.idle();

      expect(harness.terminalTail).toHaveBeenCalledWith('c1');
      expect(harness.move).toHaveBeenCalledTimes(1);
    });

    it('ignores an ordinary chat error and a successful chat stop', async () => {
      const harness = setup({
        conversations: [
          {
            conversationId: 'c1',
            projectId: 'p1',
            taskId: 't1',
            type: 'acp',
            accountId: 'primary',
          },
        ],
      });
      harness.replyWith('c1', 'Internal error: the tool crashed');

      harness.send('c1', 'start');
      harness.send('c1', 'error');
      harness.send('c1', 'start');
      harness.send('c1', 'stop');
      await harness.service.idle();

      expect(harness.lastChatReply).toHaveBeenCalledTimes(1);
      expect(harness.usage).not.toHaveBeenCalled();
      expect(harness.move).not.toHaveBeenCalled();
    });

    it('ignores a transient 429 or overload on screen', async () => {
      const harness = setup();
      harness.showOnScreen('c1', 'API Error: 429 rate_limit_error · Retrying in 8 seconds…\r\n');

      harness.send('c1', 'start');
      harness.send('c1', 'notification', { notificationType: 'idle_prompt' });
      await harness.service.idle();
      harness.showOnScreen('c1', 'API Error: 529 {"type":"overloaded_error"}\r\n');
      harness.send('c1', 'start');
      harness.send('c1', 'error');
      await harness.service.idle();

      expect(harness.usage).not.toHaveBeenCalled();
      expect(harness.move).not.toHaveBeenCalled();
    });

    it('does not switch on the message alone when the account is not at its limit', async () => {
      const harness = setup({
        usage: { primary: { five: 60, week: 40 }, work: { five: 0, week: 0 } },
      });

      await harness.terminalLimit();

      expect(harness.usage).toHaveBeenCalled();
      expect(harness.move).not.toHaveBeenCalled();
      expect(harness.events).toEqual([]);
    });

    it('does not switch when the account usage cannot be fetched fresh', async () => {
      for (const primary of ['unavailable', 'stale'] as const) {
        const harness = setup({ usage: { primary, work: { five: 0, week: 0 } } });

        await harness.terminalLimit();

        expect(harness.move).not.toHaveBeenCalled();
      }
    });

    it('counts a weekly window at the limit', async () => {
      const harness = setup({
        usage: { primary: { five: 10, week: 100 }, work: { five: 0, week: 0 } },
      });

      await harness.terminalLimit();

      expect(harness.move).toHaveBeenCalledTimes(1);
    });

    it('only looks at conversations that were working when the turn ended', async () => {
      const harness = setup();
      harness.showOnScreen('c1', LIMIT_SCREEN);

      harness.send('c1', 'notification', { notificationType: 'idle_prompt' });
      await harness.service.idle();

      expect(harness.terminalTail).not.toHaveBeenCalled();
      expect(harness.move).not.toHaveBeenCalled();
    });

    it('treats a permission prompt as a pause, not the end of the turn', async () => {
      const harness = setup();
      harness.showOnScreen('c1', LIMIT_SCREEN);

      harness.send('c1', 'start');
      harness.send('c1', 'notification', { notificationType: 'permission_prompt' });
      await harness.service.idle();
      expect(harness.terminalTail).not.toHaveBeenCalled();

      harness.send('c1', 'notification', { notificationType: 'idle_prompt' });
      await harness.service.idle();
      expect(harness.move).toHaveBeenCalledTimes(1);
    });

    it('ignores other providers and conversations it may not move', async () => {
      const harness = setup();
      harness.showOnScreen('c1', LIMIT_SCREEN);
      harness.showOnScreen('other', LIMIT_SCREEN);

      harness.send('c1', 'start', {}, 'codex');
      harness.send('c1', 'notification', { notificationType: 'idle_prompt' }, 'codex');
      harness.send('other', 'start');
      harness.send('other', 'notification', { notificationType: 'idle_prompt' });
      await harness.service.idle();

      expect(harness.move).not.toHaveBeenCalled();
    });
  });

  describe('target choice', () => {
    it('prefers the lowest five-hour figure, then the lowest weekly, a missing window as 0%', async () => {
      const harness = setup({
        accounts: [account('primary'), account('a'), account('b'), account('c')],
        usage: {
          primary: { five: 100, week: 50 },
          a: { five: 30, week: 10 },
          b: { five: null, week: 60 },
          c: { five: 0, week: 20 },
        },
      });

      await harness.terminalLimit();

      expect(harness.move.mock.calls[0]?.[0].accountId).toBe('c');
    });

    it('skips accounts at 90% or more and accounts without fresh usage', async () => {
      const harness = setup({
        accounts: [
          account('primary'),
          account('stale', false),
          account('busy-five'),
          account('busy-week'),
          account('unknown'),
          account('ok'),
        ],
        usage: {
          primary: { five: 100, week: 50 },
          stale: 'stale',
          'busy-five': { five: 90, week: 0 },
          'busy-week': { five: 0, week: 95 },
          unknown: 'unavailable',
          ok: { five: 89, week: 89 },
        },
      });

      await harness.terminalLimit();

      expect(harness.move.mock.calls[0]?.[0].accountId).toBe('ok');
    });

    it('takes an account flagged signed out when its usage was just fetched fresh', async () => {
      const harness = setup({
        accounts: [account('primary'), account('work', false)],
        usage: { primary: { five: 100, week: 0 }, work: { five: 5, week: 5 } },
      });

      await harness.terminalLimit();

      expect(harness.move.mock.calls[0]?.[0].accountId).toBe('work');
    });

    it('reports when no account qualifies, and moves nothing', async () => {
      const harness = setup({
        usage: { primary: { five: 100, week: 50 }, work: { five: 95, week: 0 }, spare: 'stale' },
      });

      await harness.terminalLimit();

      expect(harness.move).not.toHaveBeenCalled();
      expect(harness.events).toEqual([
        {
          type: 'limit-unhandled',
          conversationId: 'c1',
          projectId: 'p1',
          taskId: 't1',
          accountId: 'primary',
          reason: 'no-eligible-account',
        },
      ]);
    });
  });

  describe('guards', () => {
    it('moves one conversation at most once in 15 minutes', async () => {
      const harness = setup();
      await harness.terminalLimit();
      // Now on `work`, which runs out too.
      harness.conversations.set('c1', { ...harness.conversations.get('c1')!, accountId: 'work' });
      harness.setUsage({
        primary: { five: 100, week: 50, resetsAt: '2026-11-10T15:00:00.000Z' },
        work: { five: 100, week: 30 },
        spare: { five: 0, week: 0 },
      });
      harness.advance(FORCED_USAGE_REUSE_MS);

      await harness.terminalLimit();

      expect(harness.move).toHaveBeenCalledTimes(1);
      expect(harness.events.at(-1)).toMatchObject({ type: 'limit-unhandled', reason: 'cooldown' });

      harness.advance(AUTO_MOVE_COOLDOWN_MS);
      await harness.terminalLimit();
      expect(harness.move).toHaveBeenCalledTimes(2);
      expect(harness.move.mock.calls[1]?.[0].accountId).toBe('spare');
    });

    it('never moves back to an account that hit its limit before its window resets', async () => {
      const harness = setup({
        accounts: [account('primary'), account('work')],
        usage: {
          primary: { five: 100, week: 50, resetsAt: '2026-11-10T13:00:00.000Z' },
          work: { five: 0, week: 0 },
        },
      });
      await harness.terminalLimit();
      expect(harness.move).toHaveBeenCalledTimes(1);

      // The figures say primary is fine again, but its window has not reset yet.
      harness.conversations.set('c1', { ...harness.conversations.get('c1')!, accountId: 'work' });
      harness.setUsage({ primary: { five: 0, week: 0 }, work: { five: 100, week: 0 } });
      harness.advance(AUTO_MOVE_COOLDOWN_MS);
      await harness.terminalLimit();
      expect(harness.move).toHaveBeenCalledTimes(1);
      expect(harness.events.at(-1)).toMatchObject({ reason: 'no-eligible-account' });

      // After the reset time it may take conversations again.
      harness.advance(60 * 60_000);
      await harness.terminalLimit();
      expect(harness.move).toHaveBeenCalledTimes(2);
      expect(harness.move.mock.calls[1]?.[0].accountId).toBe('primary');
    });

    it('moves at most three conversations onto one account in a burst; the rest stay', async () => {
      const ids = ['c1', 'c2', 'c3', 'c4'];
      const harness = setup({
        accounts: [account('primary'), account('work')],
        usage: { primary: { five: 100, week: 0 }, work: { five: 10, week: 10 } },
        conversations: ids.map((conversationId) => ({
          conversationId,
          projectId: 'p1',
          taskId: 't1',
          type: 'pty' as const,
          accountId: 'primary',
        })),
      });

      for (const id of ids) {
        harness.showOnScreen(id, LIMIT_SCREEN);
        harness.send(id, 'start');
      }
      for (const id of ids) harness.send(id, 'notification', { notificationType: 'idle_prompt' });
      await harness.service.idle();

      expect(harness.move.mock.calls.map(([input]) => input.conversationId)).toEqual([
        'c1',
        'c2',
        'c3',
      ]);
      expect(harness.events).toEqual([
        expect.objectContaining({ conversationId: 'c4', reason: 'burst-cap' }),
      ]);
    });

    it('handles conversations one at a time, re-checking the target before each', async () => {
      const harness = setup({
        conversations: ['c1', 'c2'].map((conversationId) => ({
          conversationId,
          projectId: 'p1',
          taskId: 't1',
          type: 'pty' as const,
          accountId: 'primary',
        })),
      });
      let running = 0;
      let overlapped = false;
      harness.move.mockImplementation(async (input) => {
        running++;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        // `work` fills up once it has taken the first conversation.
        harness.setUsage({
          primary: { five: 100, week: 0 },
          work: { five: 95, week: 0 },
          spare: { five: 50, week: 0 },
        });
        harness.advance(FORCED_USAGE_REUSE_MS);
        return ok(input);
      });

      for (const id of ['c1', 'c2']) {
        harness.showOnScreen(id, LIMIT_SCREEN);
        harness.send(id, 'start');
        harness.send(id, 'notification', { notificationType: 'idle_prompt' });
      }
      await harness.service.idle();

      expect(overlapped).toBe(false);
      expect(harness.move.mock.calls.map(([input]) => input.accountId)).toEqual(['work', 'spare']);
    });

    it('reports a failed move with its message', async () => {
      const harness = setup();
      harness.move.mockResolvedValueOnce(err({ type: 'restart-failed', message: 'no session' }));

      await harness.terminalLimit();

      expect(harness.events).toEqual([
        expect.objectContaining({
          type: 'limit-unhandled',
          reason: 'move-failed',
          message: 'no session',
          accountId: 'primary',
        }),
      ]);
    });
  });

  it('does nothing when the setting is off', async () => {
    const harness = setup({ enabled: false });

    await harness.terminalLimit();

    expect(harness.terminalTail).not.toHaveBeenCalled();
    expect(harness.usage).not.toHaveBeenCalled();
    expect(harness.move).not.toHaveBeenCalled();
  });

  it('does nothing with a single account', async () => {
    const harness = setup({ accounts: [account('primary')] });

    await harness.terminalLimit();

    expect(harness.usage).not.toHaveBeenCalled();
    expect(harness.move).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });
});
