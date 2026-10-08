import { err, ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_REF } from '#primitives/host/api';
import type { TempStoreHandle } from '#primitives/sqlite-store/api';
import type { AutomationRun } from '../../api/run';
import { AutomationRunStore } from '../persistence/run-store';
import type { AutomationsDb } from '../persistence/store';
import { automationsStore } from '../persistence/store';
import type { AutomationDeliveryPort, AutomationSessionOutcome } from '../ports/delivery';
import { createAutomationRunExecutor, RUN_CANCELLED_REASON } from './executor';
import { AutomationRunTransitions } from './transitions';

const REQUEST_ID = '0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f';

const worktree = {
  host: LOCAL_HOST_REF,
  path: { root: { kind: 'posix' as const }, segments: ['pool', 'req-x'] },
};

const configSnapshot: AutomationRun['configSnapshot'] = {
  name: 'Feature requests',
  schedule: { expr: '0 9 * * *', tz: 'UTC' },
  agent: {
    type: 'acp',
    start: { providerId: 'claude', model: null, initialQueue: [{ text: 'Do it' }] },
  },
  workspace: {
    kind: 'worktree',
    repository: { host: LOCAL_HOST_REF, path: { root: { kind: 'posix' }, segments: ['repo'] } },
    worktreePoolPath: { root: { kind: 'posix' }, segments: ['pool', 'repo-1'] },
    baseRemote: 'origin',
    preservePatterns: [],
    git: {
      kind: 'create-branch',
      fromBranch: { type: 'remote', branch: 'main', remote: { name: 'origin', url: 'u' } },
      pushRemote: null,
    },
  },
  completion: { kind: 'pull-request', baseBranch: 'main', remote: 'origin', timeoutMs: 1_000 },
};

function fakeDeliveryPort(
  outcome: AutomationSessionOutcome,
  publish: AutomationDeliveryPort['publish'] = async () =>
    ok({ outcome: 'pull-request', url: 'https://example.test/pr/7' })
) {
  return {
    awaitSession: vi.fn(async () => outcome),
    stopSession: vi.fn(async () => {}),
    publish: vi.fn(publish),
  } satisfies AutomationDeliveryPort;
}

describe('automation run delivery', () => {
  let handle: TempStoreHandle<AutomationsDb>;
  let runStore: AutomationRunStore;
  let transitions: AutomationRunTransitions;
  let deliveryStates: string[];

  beforeEach(async () => {
    handle = await automationsStore.openTemp();
    runStore = new AutomationRunStore(handle);
    deliveryStates = [];
    transitions = new AutomationRunTransitions({
      runStore,
      onRunChanged: (run) => {
        if (run.delivery) deliveryStates.push(run.delivery.state);
      },
    });
  });

  afterEach(() => {
    handle.close();
  });

  function claimedRun(overrides: Partial<Omit<AutomationRun, 'seq'>> = {}): AutomationRun {
    const inserted = runStore.insertRun({
      id: REQUEST_ID,
      automationId: 'auto-1',
      status: 'queued',
      triggerKind: 'manual',
      configSnapshot,
      generatedName: 'req-x',
      scheduledAt: null,
      deadlineAt: null,
      startedAt: null,
      finishedAt: null,
      workspace: null,
      branchName: null,
      conversationId: null,
      sessionId: null,
      error: null,
      request: { id: REQUEST_ID, title: 'Add export', body: 'Please', requester: { name: 'Sam' } },
      ...overrides,
    });
    if (!inserted) throw new Error('insert failed');
    const claimed = transitions.claimQueued(inserted.id, 2_000);
    if (!claimed) throw new Error('claim failed');
    return claimed;
  }

  function executor(deliveryPort: AutomationDeliveryPort | undefined, branchName = 'req-x') {
    return createAutomationRunExecutor({
      transitions,
      workspacePort: { provision: async () => ok({ workspace: worktree, branchName }) },
      sessionPort: { start: async () => ok({ sessionId: 'sess-1' }) },
      deliveryPort,
      createConversationId: () => 'conv-1',
      now: () => 9_000,
    });
  }

  it('opens a ready pull request after a clean turn', async () => {
    const delivery = fakeDeliveryPort('clean');

    await executor(delivery)(claimedRun(), new AbortController().signal);

    const run = runStore.getRun(REQUEST_ID);
    expect(run?.status).toBe('done');
    expect(run?.delivery).toEqual({
      state: 'pr_open',
      pullRequestUrl: 'https://example.test/pr/7',
      error: null,
      finishedAt: 9_000,
    });
    expect(deliveryStates).toEqual(['agent_running', 'publishing', 'pr_open']);
    expect(delivery.awaitSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { conversationId: 'conv-1', type: 'acp' },
        timeoutMs: 1_000,
      })
    );
    expect(delivery.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/pool/req-x',
        branch: 'req-x',
        baseBranch: 'main',
        remote: 'origin',
        title: 'Add export',
        draft: false,
      }),
      expect.anything()
    );
    expect(delivery.stopSession).not.toHaveBeenCalled();
  });

  it('stops the agent and opens a draft pull request on timeout', async () => {
    const delivery = fakeDeliveryPort('timeout');

    await executor(delivery)(claimedRun(), new AbortController().signal);

    expect(delivery.stopSession).toHaveBeenCalledWith({ conversationId: 'conv-1', type: 'acp' });
    expect(delivery.publish).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
      expect.anything()
    );
    expect(runStore.getRun(REQUEST_ID)?.delivery?.state).toBe('pr_draft');
  });

  it('records no_changes when a clean turn produced nothing', async () => {
    const delivery = fakeDeliveryPort('clean', async () => ok({ outcome: 'no-changes' }));

    await executor(delivery)(claimedRun(), new AbortController().signal);

    expect(runStore.getRun(REQUEST_ID)?.delivery).toMatchObject({
      state: 'no_changes',
      pullRequestUrl: null,
      error: null,
    });
  });

  it('fails when an incomplete turn produced nothing', async () => {
    const delivery = fakeDeliveryPort('incomplete', async () => ok({ outcome: 'no-changes' }));

    await executor(delivery)(claimedRun(), new AbortController().signal);

    expect(runStore.getRun(REQUEST_ID)?.delivery).toMatchObject({
      state: 'failed',
      error: { code: 'agent_incomplete' },
    });
  });

  it('records a publish failure', async () => {
    const delivery = fakeDeliveryPort('clean', async () =>
      err({ code: 'publish-failed', message: 'denied' })
    );

    await executor(delivery)(claimedRun(), new AbortController().signal);

    expect(runStore.getRun(REQUEST_ID)?.delivery).toMatchObject({
      state: 'failed',
      error: { code: 'publish-failed', message: 'denied' },
    });
  });

  it('stops the agent and records cancelled on an explicit cancel', async () => {
    const delivery = fakeDeliveryPort('aborted');
    const controller = new AbortController();
    controller.abort(RUN_CANCELLED_REASON);

    await executor(delivery)(claimedRun(), controller.signal);

    expect(delivery.stopSession).toHaveBeenCalled();
    expect(delivery.publish).not.toHaveBeenCalled();
    expect(runStore.getRun(REQUEST_ID)?.delivery?.state).toBe('cancelled');
  });

  it('leaves delivery in flight on runtime shutdown so restart recovery can mark it', async () => {
    const delivery = fakeDeliveryPort('aborted');
    const controller = new AbortController();
    controller.abort();

    await executor(delivery)(claimedRun(), controller.signal);

    expect(delivery.stopSession).not.toHaveBeenCalled();
    expect(runStore.getRun(REQUEST_ID)?.delivery?.state).toBe('agent_running');
    expect(runStore.listRunsWithActiveDelivery().map((run) => run.id)).toEqual([REQUEST_ID]);
  });

  it('skips delivery entirely for automations without a completion config', async () => {
    const delivery = fakeDeliveryPort('clean');
    const { completion: _completion, ...withoutCompletion } = configSnapshot;

    await executor(delivery)(
      claimedRun({ configSnapshot: withoutCompletion }),
      new AbortController().signal
    );

    expect(delivery.awaitSession).not.toHaveBeenCalled();
    expect(runStore.getRun(REQUEST_ID)?.delivery).toBeUndefined();
  });

  it('fails delivery when no delivery port is available', async () => {
    await executor(undefined)(claimedRun(), new AbortController().signal);

    expect(runStore.getRun(REQUEST_ID)?.delivery).toMatchObject({
      state: 'failed',
      error: { code: 'delivery_unsupported' },
    });
  });
});
