import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_REF } from '#primitives/host/api';
import type { AutomationRun, AutomationRunRequest } from '#runtimes/automations/api';
import type { TriggerGatewayConfig } from './config';
import type { TriggerDaemon } from './daemon';
import { createTriggerHandler, type TriggerLogEntry, type TriggerRequest } from './http';

const TOKEN = 'a-long-enough-secret-token-for-the-gateway';
const REQUEST_ID = '0f3c9a52-6d1e-4b7a-9c3e-2a1b4c5d6e7f';

const config: TriggerGatewayConfig = {
  token: TOKEN,
  listen: { host: '127.0.0.1', port: 7461 },
  maxQueued: 2,
  triggers: { 'maestro-feature': { automationId: 'auto-1' } },
};

function runFor(
  request: AutomationRunRequest,
  overrides: Partial<AutomationRun> = {}
): AutomationRun {
  return {
    id: request.id,
    seq: 1,
    automationId: 'auto-1',
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
    request,
    ...overrides,
  };
}

function fakeDaemon(initial: AutomationRun[] = []) {
  const runs = new Map(initial.map((run) => [run.id, run]));
  const daemon = {
    healthy: vi.fn<TriggerDaemon['healthy']>(async () => true),
    startRun: vi.fn<TriggerDaemon['startRun']>(async (_automationId, request) => {
      const run = runFor(request);
      runs.set(run.id, run);
      return ok(run);
    }),
    getRun: vi.fn<TriggerDaemon['getRun']>(async (_automationId, runId) =>
      ok(runs.get(runId) ?? null)
    ),
    cancelRun: vi.fn<TriggerDaemon['cancelRun']>(async (_automationId, runId) => {
      const run = runs.get(runId);
      if (run) runs.set(runId, { ...run, status: 'cancelled', finishedAt: 5 });
      return ok(undefined);
    }),
    queuedCount: vi.fn<TriggerDaemon['queuedCount']>(async () => ok(0)),
  } satisfies TriggerDaemon;
  return daemon;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; rawBody?: string } = {}
): TriggerRequest {
  const token = options.token === undefined ? TOKEN : options.token;
  return {
    method,
    path,
    authorization: token === null ? undefined : `Bearer ${token}`,
    readBody: vi.fn(async () => ({
      kind: 'ok' as const,
      text: options.rawBody ?? JSON.stringify(options.body ?? {}),
    })),
  };
}

const submission = {
  requestId: REQUEST_ID,
  trigger: 'maestro-feature',
  title: 'Add CSV export',
  body: 'Please',
  requester: { id: 'u_1', name: 'Sam' },
  source: { app: 'admin' },
};

describe('trigger gateway', () => {
  it('rejects a missing or wrong bearer token before reading the body', async () => {
    const daemon = fakeDaemon();
    const handle = createTriggerHandler({ config, daemon });
    const missing = request('POST', '/v1/requests', { body: submission, token: null });
    const wrong = request('POST', '/v1/requests', { body: submission, token: 'nope' });

    expect((await handle(missing)).status).toBe(401);
    expect((await handle(wrong)).status).toBe(401);
    expect(missing.readBody).not.toHaveBeenCalled();
    expect(daemon.startRun).not.toHaveBeenCalled();
  });

  it('queues a new request and returns 202', async () => {
    const daemon = fakeDaemon();
    const log: TriggerLogEntry[] = [];
    const handle = createTriggerHandler({ config, daemon, log: (entry) => log.push(entry) });

    const response = await handle(request('POST', '/v1/requests', { body: submission }));

    expect(response).toEqual({
      status: 202,
      body: {
        requestId: REQUEST_ID,
        runId: REQUEST_ID,
        status: 'queued',
        branch: null,
        pullRequestUrl: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    expect(daemon.startRun).toHaveBeenCalledWith('auto-1', {
      id: REQUEST_ID,
      title: 'Add CSV export',
      body: 'Please',
      requester: { id: 'u_1', name: 'Sam' },
      source: { app: 'admin' },
    });
    expect(log).toEqual([
      expect.objectContaining({ status: 202, requestId: REQUEST_ID, requestStatus: 'queued' }),
    ]);
  });

  it('returns the existing run with 200 for a repeated request id, even with a full queue', async () => {
    const daemon = fakeDaemon([runFor({ id: REQUEST_ID, title: 'Add CSV export', body: '' })]);
    daemon.queuedCount.mockResolvedValue(ok(99));
    const handle = createTriggerHandler({ config, daemon });

    const response = await handle(request('POST', '/v1/requests', { body: submission }));

    expect(response.status).toBe(200);
    expect(daemon.startRun).not.toHaveBeenCalled();
  });

  it('refuses new requests with 429 when the queue is full', async () => {
    const daemon = fakeDaemon();
    daemon.queuedCount.mockResolvedValue(ok(2));
    const handle = createTriggerHandler({ config, daemon });

    const response = await handle(request('POST', '/v1/requests', { body: submission }));

    expect(response).toEqual({ status: 429, body: { error: 'queue_full' } });
    expect(daemon.startRun).not.toHaveBeenCalled();
  });

  it('rejects unknown triggers, including prototype keys', async () => {
    const handle = createTriggerHandler({ config, daemon: fakeDaemon() });

    for (const trigger of ['other', 'constructor', '__proto__']) {
      const response = await handle(
        request('POST', '/v1/requests', { body: { ...submission, trigger } })
      );
      expect(response).toEqual({ status: 404, body: { error: 'unknown_trigger' } });
    }
  });

  it('rejects malformed submissions', async () => {
    const handle = createTriggerHandler({ config, daemon: fakeDaemon() });

    expect((await handle(request('POST', '/v1/requests', { rawBody: '{' }))).body).toEqual({
      error: 'invalid_json',
    });
    for (const body of [
      { ...submission, requestId: 'not-a-uuid' },
      { ...submission, title: '' },
      { ...submission, title: 'x'.repeat(201) },
      { ...submission, body: 'x'.repeat(32_769) },
    ]) {
      const response = await handle(request('POST', '/v1/requests', { body }));
      expect(response.status).toBe(400);
    }
  });

  it('rejects an oversized body with 413', async () => {
    const handle = createTriggerHandler({ config, daemon: fakeDaemon() });
    const oversized = request('POST', '/v1/requests');
    oversized.readBody = async () => ({ kind: 'too-large' });

    expect((await handle(oversized)).status).toBe(413);
  });

  it('maps daemon refusals to caller-facing errors', async () => {
    const daemon = fakeDaemon();
    const handle = createTriggerHandler({ config, daemon });

    daemon.startRun.mockResolvedValueOnce(err({ type: 'automation-not-found', message: 'gone' }));
    expect((await handle(request('POST', '/v1/requests', { body: submission }))).status).toBe(404);

    daemon.startRun.mockResolvedValueOnce(err({ type: 'automation-disabled', message: 'off' }));
    expect((await handle(request('POST', '/v1/requests', { body: submission }))).status).toBe(409);

    daemon.getRun.mockResolvedValueOnce(err({ type: 'daemon-unavailable', message: 'down' }));
    expect((await handle(request('POST', '/v1/requests', { body: submission }))).status).toBe(503);
  });

  it('reports the pull request once delivery finishes', async () => {
    const daemon = fakeDaemon([
      runFor(
        { id: REQUEST_ID, title: 'Add CSV export', body: '' },
        {
          status: 'done',
          branchName: 'req-add-csv-export-0f3c9a52',
          startedAt: 10,
          finishedAt: 20,
          delivery: {
            state: 'pr_open',
            pullRequestUrl: 'https://example.test/pr/7',
            error: null,
            finishedAt: 90,
          },
        }
      ),
    ]);
    const handle = createTriggerHandler({ config, daemon });

    const response = await handle(request('GET', `/v1/requests/${REQUEST_ID}`));

    expect(response).toEqual({
      status: 200,
      body: {
        requestId: REQUEST_ID,
        runId: REQUEST_ID,
        status: 'pr_open',
        branch: 'req-add-csv-export-0f3c9a52',
        pullRequestUrl: 'https://example.test/pr/7',
        error: null,
        startedAt: 10,
        finishedAt: 90,
      },
    });
  });

  it('returns 404 for an unknown request and 400 for a malformed id', async () => {
    const handle = createTriggerHandler({ config, daemon: fakeDaemon() });

    expect((await handle(request('GET', `/v1/requests/${REQUEST_ID}`))).status).toBe(404);
    expect((await handle(request('GET', '/v1/requests/..%2F..'))).status).toBe(400);
  });

  it('cancels an in-flight request and refuses to cancel a finished one', async () => {
    const daemon = fakeDaemon([runFor({ id: REQUEST_ID, title: 'Add CSV export', body: '' })]);
    const handle = createTriggerHandler({ config, daemon });

    const cancelled = await handle(request('POST', `/v1/requests/${REQUEST_ID}/cancel`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });

    const again = await handle(request('POST', `/v1/requests/${REQUEST_ID}/cancel`));
    expect(again).toEqual({ status: 409, body: { error: 'already_finished' } });
    expect(daemon.cancelRun).toHaveBeenCalledTimes(1);
  });

  it('reports daemon health and rejects unknown routes and methods', async () => {
    const daemon = fakeDaemon();
    const handle = createTriggerHandler({ config, daemon });

    expect((await handle(request('GET', '/healthz'))).status).toBe(200);
    daemon.healthy.mockResolvedValueOnce(false);
    expect((await handle(request('GET', '/healthz'))).status).toBe(503);
    expect((await handle(request('GET', '/v1/requests'))).status).toBe(405);
    expect((await handle(request('DELETE', `/v1/requests/${REQUEST_ID}`))).status).toBe(405);
    expect((await handle(request('GET', '/v2/anything'))).status).toBe(404);
  });
});
