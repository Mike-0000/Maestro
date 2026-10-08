import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import {
  automationsContract,
  type AutomationRun,
  type StartRunInput,
} from '@emdash/core/runtimes/automations/api';
import { err, ok } from '@emdash/shared';
import { createEventStreamHost } from '@emdash/wire/live';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorkspaceWireController } from '../testing/controller';
import { serveSocket } from '../wire/serve-socket';
import { createTriggerDaemon } from './daemon-client';

const REQUEST_ID = '0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f';
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function run(input: StartRunInput): AutomationRun {
  return {
    id: input.request?.id ?? 'run-1',
    seq: 1,
    automationId: input.automationId,
    status: 'queued',
    triggerKind: 'manual',
    configSnapshot: {
      name: 'Feature requests',
      schedule: { expr: '0 9 * * *', tz: 'UTC' },
      agent: {
        type: 'acp',
        start: { providerId: 'claude', model: null, initialQueue: [{ text: 'Do it' }] },
      },
      workspace: {
        kind: 'directory',
        path: { host: LOCAL_HOST_REF, path: { root: { kind: 'posix' }, segments: ['repo'] } },
      },
    },
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
    ...(input.request && { request: input.request }),
  };
}

/** A daemon socket whose automations runtime is an in-memory fake. */
async function serveFakeDaemon() {
  const runs = new Map<string, AutomationRun>();
  const started: StartRunInput[] = [];
  const unavailable = async () => err({ type: 'runtime-unavailable' as const, message: 'unused' });
  const automations = createTestWire(automationsContract, {
    deploy: unavailable,
    remove: unavailable,
    listRuns: unavailable,
    listChangedRuns: unavailable,
    startRun: async (input) => {
      if (input.automationId !== 'auto-1') {
        return err({
          type: 'automation-not-found',
          automationId: input.automationId,
          message: 'Automation not found',
        });
      }
      started.push(input);
      const created = run(input);
      runs.set(created.id, created);
      return ok({ run: created });
    },
    getRun: async ({ runId }) => ok({ run: runs.get(runId) ?? null }),
    cancelRun: async ({ runId }) => {
      const existing = runs.get(runId);
      if (!existing) return err({ type: 'run-not-found', runId, message: 'Run not found' });
      runs.set(runId, { ...existing, status: 'cancelled', finishedAt: 5 });
      return ok(undefined);
    },
    getRunOverview: async () =>
      ok({
        counts: {
          scheduled: 0,
          queued: runs.size,
          provisioning_workspace: 0,
          starting_session: 0,
          done: 0,
          failed: 0,
          skipped: 0,
          cancelled: 0,
        },
        latestRun: null,
        nextScheduledRun: null,
      }),
    runEvents: createEventStreamHost(automationsContract.runEvents),
  });
  disposers.push(() => automations.dispose());

  const directory = await mkdtemp(join(tmpdir(), 'emdash-trigger-daemon-'));
  const socketPath = join(directory, 'workspace.sock');
  const handle = await serveSocket(
    createTestWorkspaceWireController({ automations: automations.client }),
    { socketPath }
  );
  disposers.push(() => handle.dispose());
  return { socketPath, started };
}

describe('createTriggerDaemon', () => {
  it('starts, reads, counts, and cancels runs over the daemon socket', async () => {
    const { socketPath, started } = await serveFakeDaemon();
    const daemon = createTriggerDaemon({ socketPath, appVersion: 'test' });
    const request = { id: REQUEST_ID, title: 'Add CSV export', body: 'Please' };

    expect(await daemon.healthy()).toBe(true);

    const startedRun = await daemon.startRun('auto-1', request);
    expect(startedRun).toMatchObject({ success: true, data: { id: REQUEST_ID, request } });
    expect(started).toEqual([{ automationId: 'auto-1', request }]);

    expect(await daemon.getRun('auto-1', REQUEST_ID)).toMatchObject({
      success: true,
      data: { id: REQUEST_ID, status: 'queued' },
    });
    expect(await daemon.getRun('auto-1', '00000000-0000-4000-8000-000000000000')).toEqual({
      success: true,
      data: null,
    });
    expect(await daemon.queuedCount('auto-1')).toEqual({ success: true, data: 1 });

    expect(await daemon.cancelRun('auto-1', REQUEST_ID)).toEqual({
      success: true,
      data: undefined,
    });
    expect(await daemon.getRun('auto-1', REQUEST_ID)).toMatchObject({
      success: true,
      data: { status: 'cancelled' },
    });
  });

  it('passes typed daemon refusals through', async () => {
    const { socketPath } = await serveFakeDaemon();
    const daemon = createTriggerDaemon({ socketPath, appVersion: 'test' });

    expect(
      await daemon.startRun('other', { id: REQUEST_ID, title: 'Add CSV export', body: '' })
    ).toMatchObject({ success: false, error: { type: 'automation-not-found' } });
  });

  it('reports an absent daemon as unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emdash-trigger-daemon-'));
    const daemon = createTriggerDaemon({
      socketPath: join(directory, 'missing.sock'),
      appVersion: 'test',
    });

    expect(await daemon.healthy()).toBe(false);
    expect(await daemon.getRun('auto-1', REQUEST_ID)).toMatchObject({
      success: false,
      error: { type: 'daemon-unavailable' },
    });
  });
});
