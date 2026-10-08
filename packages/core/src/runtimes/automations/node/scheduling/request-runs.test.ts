import { ManualClock } from '@emdash/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_REF } from '#primitives/host/api';
import type { TempStoreHandle } from '#primitives/sqlite-store/api';
import type { AutomationDeployment } from '../../api/deployment';
import type { AutomationRun, AutomationRunRequest } from '../../api/run';
import { AutomationDeploymentStore } from '../persistence/deployment-store';
import { AutomationRunStore } from '../persistence/run-store';
import type { AutomationsDb } from '../persistence/store';
import { automationsStore } from '../persistence/store';
import { RUN_CANCELLED_REASON } from '../runs/executor';
import { AutomationRunTransitions } from '../runs/transitions';
import { AutomationScheduler } from './scheduler';

const START = Date.UTC(2026, 6, 16, 8, 59);

function deployment(overrides: Partial<AutomationDeployment> = {}): AutomationDeployment {
  return {
    automationId: 'auto-1',
    enabled: true,
    name: 'Feature requests',
    schedule: { expr: '0 9 * * *', tz: 'UTC' },
    triggers: { cron: false },
    agent: {
      type: 'acp',
      start: { providerId: 'claude', model: null, initialQueue: [{ text: 'Standing' }] },
    },
    workspace: {
      kind: 'worktree',
      repository: { host: LOCAL_HOST_REF, path: { root: { kind: 'posix' }, segments: ['repo'] } },
      worktreePoolPath: { root: { kind: 'posix' }, segments: ['worktrees', 'repo-1'] },
      baseRemote: 'origin',
      preservePatterns: [],
      git: {
        kind: 'create-branch',
        fromBranch: { type: 'local', branch: 'main' },
        pushRemote: null,
      },
    },
    completion: { kind: 'pull-request', baseBranch: 'main', remote: 'origin' },
    revision: 1,
    ...overrides,
  };
}

function request(index: number, title = `Request ${index}`): AutomationRunRequest {
  return { id: `00000000-0000-4000-8000-00000000000${index}`, title, body: 'Details' };
}

/** An executor whose runs stay in flight until released, like a run in delivery. */
function heldExecutor() {
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const execute = vi.fn(
    (run: AutomationRun, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signals.set(run.id, signal);
        releases.set(run.id, resolve);
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      })
  );
  return { execute, release: (id: string) => releases.get(id)?.(), signals };
}

const schedulers: AutomationScheduler[] = [];
const handles: TempStoreHandle<AutomationsDb>[] = [];

async function createHarness(
  item: AutomationDeployment,
  execute: (run: AutomationRun, signal: AbortSignal) => Promise<void>
) {
  const handle = await automationsStore.openTemp();
  handles.push(handle);
  const deploymentStore = new AutomationDeploymentStore(handle);
  deploymentStore.upsertDeployment(item, START);
  const runStore = new AutomationRunStore(handle);
  const transitions = new AutomationRunTransitions({ runStore });
  const scheduler = new AutomationScheduler({
    clock: new ManualClock(START),
    deploymentStore,
    runStore,
    transitions,
    execute,
  });
  schedulers.push(scheduler);
  return { runStore, scheduler, transitions };
}

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
  for (const handle of handles.splice(0)) handle.close();
});

describe('AutomationScheduler request runs', () => {
  it('does not schedule cron runs for an on-demand automation', async () => {
    const { runStore, scheduler } = await createHarness(deployment(), async () => {});

    scheduler.start();

    expect(runStore.getScheduledRun('auto-1')).toBeNull();
  });

  it('skips a pending scheduled run once the automation becomes on-demand', async () => {
    const handle = await automationsStore.openTemp();
    handles.push(handle);
    const deploymentStore = new AutomationDeploymentStore(handle);
    deploymentStore.upsertDeployment(deployment({ triggers: undefined }), START);
    const runStore = new AutomationRunStore(handle);
    const scheduler = new AutomationScheduler({
      clock: new ManualClock(START),
      deploymentStore,
      runStore,
      transitions: new AutomationRunTransitions({ runStore }),
      execute: async () => {},
    });
    schedulers.push(scheduler);
    scheduler.start();
    const scheduled = runStore.getScheduledRun('auto-1');
    expect(scheduled).not.toBeNull();

    deploymentStore.upsertDeployment(deployment({ revision: 2 }), START);
    scheduler.reconcile();

    expect(runStore.getScheduledRun('auto-1')).toBeNull();
    expect(runStore.getRun(scheduled?.id ?? '')?.error).toEqual({
      step: 'queue',
      code: 'redeployed',
    });
  });

  it('uses the request id as the run id and snapshots the request prompt', async () => {
    const held = heldExecutor();
    const { scheduler } = await createHarness(deployment(), held.execute);
    scheduler.start();

    const run = scheduler.runNow(deployment(), request(1, 'Add CSV export'));

    expect(run.id).toBe(request(1).id);
    expect(run.generatedName).toBe('req-add-csv-export-00000000');
    expect(run.request).toEqual(request(1, 'Add CSV export'));
    expect(run.configSnapshot.completion).toEqual(deployment().completion);
    if (run.configSnapshot.agent.type !== 'acp') throw new Error('expected acp');
    expect(run.configSnapshot.agent.start.initialQueue[0]?.text).toBe(
      'Standing\n\n---\n\nFeature request:\nAdd CSV export\n\nDetails'
    );
  });

  it('returns the existing run when a request is submitted twice', async () => {
    const held = heldExecutor();
    const { scheduler } = await createHarness(deployment(), held.execute);
    scheduler.start();

    const first = scheduler.runNow(deployment(), request(1));
    const second = scheduler.runNow(deployment(), request(1, 'A different title'));

    expect(second.id).toBe(first.id);
    expect(second.request?.title).toBe('Request 1');
    await vi.waitFor(() => expect(held.execute).toHaveBeenCalled());
    expect(held.execute).toHaveBeenCalledTimes(1);
  });

  it('queues requests beyond the automation limit instead of skipping them', async () => {
    const held = heldExecutor();
    const item = deployment({ maxConcurrentRuns: 2 });
    const { runStore, scheduler } = await createHarness(item, held.execute);
    scheduler.start();

    scheduler.runNow(item, request(1));
    scheduler.runNow(item, request(2));
    scheduler.runNow(item, request(3));

    await vi.waitFor(() => expect(held.execute).toHaveBeenCalledTimes(2));
    expect(runStore.getRun(request(3).id)?.status).toBe('queued');

    held.release(request(1).id);
    await vi.waitFor(() => expect(held.execute).toHaveBeenCalledTimes(3));
    expect(runStore.getRun(request(3).id)?.status).toBe('provisioning_workspace');
  });

  it('still skips an overlapping manual run that carries no request', async () => {
    const held = heldExecutor();
    const { runStore, scheduler } = await createHarness(deployment(), held.execute);
    scheduler.start();

    scheduler.runNow(deployment(), request(1));
    const manual = scheduler.runNow(deployment());

    expect(runStore.getRun(manual.id)).toMatchObject({
      status: 'skipped',
      error: { step: 'queue', code: 'previous_running' },
    });
  });

  it('aborts a run in its delivery phase with the cancel reason', async () => {
    const held = heldExecutor();
    const { scheduler, transitions } = await createHarness(deployment(), held.execute);
    scheduler.start();
    const run = scheduler.runNow(deployment(), request(1));
    await vi.waitFor(() => expect(held.execute).toHaveBeenCalled());
    transitions.markStartingSession(run.id, {
      workspace: { host: LOCAL_HOST_REF, path: { root: { kind: 'posix' }, segments: ['wt'] } },
      branchName: 'req-x',
    });
    transitions.markDone(run.id, { conversationId: 'conv-1', sessionId: null }, START);

    scheduler.cancelRun(run.id);

    const signal = held.signals.get(run.id);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(RUN_CANCELLED_REASON);
  });

  it('marks a delivery interrupted by a restart as failed', async () => {
    const held = heldExecutor();
    const { runStore, scheduler, transitions } = await createHarness(deployment(), held.execute);
    scheduler.start();
    const run = scheduler.runNow(deployment(), request(1));
    await vi.waitFor(() => expect(held.execute).toHaveBeenCalled());
    transitions.markStartingSession(run.id, {
      workspace: { host: LOCAL_HOST_REF, path: { root: { kind: 'posix' }, segments: ['wt'] } },
      branchName: 'req-x',
    });
    transitions.markDone(run.id, { conversationId: 'conv-1', sessionId: null }, START);
    transitions.updateDelivery(run.id, {
      state: 'agent_running',
      pullRequestUrl: null,
      error: null,
      finishedAt: null,
    });
    await scheduler.stop();

    scheduler.start();

    expect(runStore.getRun(run.id)?.delivery).toEqual({
      state: 'failed',
      pullRequestUrl: null,
      error: { code: 'interrupted_by_restart' },
      finishedAt: START,
    });
  });
});
