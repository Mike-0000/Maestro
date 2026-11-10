import type { TuiSessionState } from '@emdash/core/runtimes/tui-agents/api';
import { describe, expect, it } from 'vitest';
import {
  RESUME_QUIET_MS,
  RESUME_SETTLE_MS,
  RESUME_TIMEOUT_MS,
  waitForTerminalSession,
} from './claude-account-move-runtime';

function state(overrides: Partial<TuiSessionState> = {}): TuiSessionState {
  return {
    conversationId: 'c1',
    providerId: 'claude',
    sessionId: 'session-1',
    status: 'running',
    cols: 80,
    rows: 24,
    resume: { requested: true, outcome: 'resumed' },
    startedAt: 0,
    ...overrides,
  };
}

/** A clock that advances only when the waiter sleeps, and a session that changes over time. */
function run(timeline: (elapsed: number) => TuiSessionState | undefined, resuming = true) {
  let now = 0;
  return waitForTerminalSession(async () => timeline(now), resuming, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  }).then((result) => ({ result, elapsed: now }));
}

describe('waitForTerminalSession', () => {
  it('waits past the fallback window and for quiet output before calling it resumed', async () => {
    const { result, elapsed } = await run((now) =>
      state({ lastOutputAt: Math.min(now, RESUME_SETTLE_MS + 500) })
    );

    expect(result.success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(RESUME_SETTLE_MS + 500 + RESUME_QUIET_MS);
  });

  it('fails when the runtime replaced the resumed session with a fresh one', async () => {
    const { result } = await run((now) =>
      now < 3_000
        ? state()
        : state({ resume: { requested: true, outcome: 'fresh-fallback', reason: 'exited' } })
    );

    expect(result).toEqual({
      success: false,
      error: 'Claude Code could not find the saved session under the new account',
    });
  });

  it('does not treat a first start as a failed resume', async () => {
    const { result } = await run(
      () => state({ resume: { requested: true, outcome: 'fresh-fallback' } }),
      false
    );

    expect(result.success).toBe(true);
  });

  it('fails when the session exited, or never came up in time', async () => {
    expect((await run(() => state({ status: 'exited' }))).result.success).toBe(false);
    const missing = await run(() => undefined);
    expect(missing.result.success).toBe(false);
    expect(missing.elapsed).toBeGreaterThanOrEqual(RESUME_TIMEOUT_MS);
  });

  it('accepts a session that is still drawing at the timeout but running', async () => {
    const { result } = await run((now) => state({ lastOutputAt: now }));

    expect(result.success).toBe(true);
  });
});
