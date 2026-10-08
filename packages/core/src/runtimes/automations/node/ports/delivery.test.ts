import { err, ok } from '@emdash/shared';
import type { Clock } from '@emdash/shared/scheduling';
import type { ContractClient } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import type {
  AutomationDeliveryContract,
  AutomationPublishInput,
  AutomationSessionStatus,
} from '../../api/delivery';
import { createDeliveryPortFromDependency } from './delivery';

/** A clock whose sleeps return immediately and move time forward by the slept amount. */
function steppingClock(): Clock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    schedule: () => {
      throw new Error('not used');
    },
    sleep: async (delayMs, options) => {
      if (options?.signal?.aborted) throw new Error('aborted');
      slept.push(delayMs);
      now += delayMs;
    },
  };
}

function fakeClient(statuses: Array<AutomationSessionStatus | 'error'>) {
  let index = 0;
  const sessionStatus = vi.fn(async () => {
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return status === 'error' ? err({ type: 'runtime-unavailable' }) : ok(status);
  });
  const stopSession = vi.fn(async () => ok(undefined));
  const publish = vi.fn();
  const client = {
    sessionStatus,
    stopSession,
    publish,
  } as unknown as ContractClient<AutomationDeliveryContract>;
  return { client, sessionStatus, stopSession, publish };
}

const working: AutomationSessionStatus = { state: 'working', clean: false };
const settledClean: AutomationSessionStatus = { state: 'settled', clean: true };
const settledDirty: AutomationSessionStatus = { state: 'settled', clean: false };
const unknown: AutomationSessionStatus = { state: 'unknown', clean: false };

const acp = { conversationId: 'conv-1', type: 'acp' as const };
const tui = { conversationId: 'conv-1', type: 'tui' as const };

function port(statuses: Array<AutomationSessionStatus | 'error'>) {
  const fake = fakeClient(statuses);
  const clock = steppingClock();
  return {
    ...fake,
    clock,
    port: createDeliveryPortFromDependency(fake.client, {
      clock,
      pollIntervalMs: 5_000,
      startupGraceMs: 60_000,
      publishRetryDelayMs: 30_000,
    }),
  };
}

describe('awaitSession', () => {
  it('reports clean once the session stays settled across two polls', async () => {
    const harness = port([working, working, settledClean, settledClean]);

    const outcome = await harness.port.awaitSession({
      session: acp,
      timeoutMs: 600_000,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('clean');
    expect(harness.sessionStatus).toHaveBeenCalledTimes(4);
  });

  it('does not settle on a single settled poll followed by more work', async () => {
    const harness = port([settledClean, working, settledDirty, settledDirty]);

    expect(
      await harness.port.awaitSession({
        session: acp,
        timeoutMs: 600_000,
        signal: new AbortController().signal,
      })
    ).toBe('incomplete');
    expect(harness.sessionStatus).toHaveBeenCalledTimes(4);
  });

  it('ignores a TUI idle report until the agent has worked', async () => {
    const harness = port([settledClean, settledClean, working, settledClean, settledClean]);

    expect(
      await harness.port.awaitSession({
        session: tui,
        timeoutMs: 600_000,
        signal: new AbortController().signal,
      })
    ).toBe('clean');
    expect(harness.sessionStatus).toHaveBeenCalledTimes(5);
  });

  it('reports incomplete when the session exits', async () => {
    const harness = port([working, { state: 'exited', clean: false }]);

    expect(
      await harness.port.awaitSession({
        session: acp,
        timeoutMs: 600_000,
        signal: new AbortController().signal,
      })
    ).toBe('incomplete');
  });

  it('reports incomplete when the session never reports within the startup grace', async () => {
    const harness = port([unknown, 'error']);

    expect(
      await harness.port.awaitSession({
        session: acp,
        timeoutMs: 600_000,
        signal: new AbortController().signal,
      })
    ).toBe('incomplete');
    expect(harness.clock.now()).toBe(60_000);
  });

  it('times out while the agent is still working', async () => {
    const harness = port([working]);

    expect(
      await harness.port.awaitSession({
        session: acp,
        timeoutMs: 12_000,
        signal: new AbortController().signal,
      })
    ).toBe('timeout');
    expect(harness.clock.slept).toEqual([5_000, 5_000, 2_000]);
  });

  it('reports aborted when the run signal fires', async () => {
    const harness = port([working]);
    const controller = new AbortController();
    controller.abort();

    expect(
      await harness.port.awaitSession({
        session: acp,
        timeoutMs: 600_000,
        signal: controller.signal,
      })
    ).toBe('aborted');
    expect(harness.sessionStatus).not.toHaveBeenCalled();
  });
});

describe('publish', () => {
  const input: AutomationPublishInput = {
    cwd: '/wt',
    branch: 'req-x',
    baseBranch: 'main',
    remote: 'origin',
    title: 'T',
    body: 'B',
    draft: false,
  };

  it('retries once after a failure', async () => {
    const harness = port([working]);
    harness.publish
      .mockResolvedValueOnce(err({ type: 'publish-failed', message: 'network' }))
      .mockResolvedValueOnce(ok({ outcome: 'pull-request', url: 'https://example.test/pr/1' }));

    const result = await harness.port.publish(input, new AbortController().signal);

    expect(result).toEqual(ok({ outcome: 'pull-request', url: 'https://example.test/pr/1' }));
    expect(harness.publish).toHaveBeenCalledTimes(2);
    expect(harness.clock.slept).toEqual([30_000]);
  });

  it('returns the second failure as a port error', async () => {
    const harness = port([working]);
    harness.publish.mockResolvedValue(err({ type: 'publish-failed', message: 'denied' }));

    expect(await harness.port.publish(input, new AbortController().signal)).toEqual(
      err({ code: 'publish-failed', message: 'denied' })
    );
    expect(harness.publish).toHaveBeenCalledTimes(2);
  });
});
