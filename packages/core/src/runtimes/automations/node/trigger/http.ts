import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { automationRunRequestSchema } from '#runtimes/automations/api';
import type { TriggerGatewayConfig } from './config';
import type { TriggerDaemon, TriggerDaemonError } from './daemon';
import { isTerminalStatus, requestView } from './status';

const MAX_BODY_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const submitRequestSchema = z.object({
  requestId: automationRunRequestSchema.shape.id,
  trigger: z.string().min(1),
  title: automationRunRequestSchema.shape.title,
  body: automationRunRequestSchema.shape.body.default(''),
  requester: automationRunRequestSchema.shape.requester,
  source: automationRunRequestSchema.shape.source,
});

export type TriggerResponse = { status: number; body: unknown };

export type TriggerLogEntry = {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  runId?: string;
  requestStatus?: string;
  error?: string;
};

/** The bearer credential a caller must present: the token itself, or its SHA-256 digest. */
export type TriggerCredential = { token: string } | { tokenDigest: string };

export type TriggerHandlerOptions = {
  /** A host that stores only the token's digest passes `tokenDigest` instead of `token`. */
  config: Pick<TriggerGatewayConfig, 'triggers' | 'maxQueued'> & TriggerCredential;
  daemon: TriggerDaemon;
  log?: (entry: TriggerLogEntry) => void;
};

export type TriggerRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  /** Reads the body on demand, so an unauthenticated caller never gets one buffered. */
  readBody(): Promise<{ kind: 'ok'; text: string } | { kind: 'too-large' }>;
};

/**
 * The gateway's whole HTTP surface, independent of `node:http` so it is tested
 * without a socket. Every route sits behind the bearer token, compared in constant
 * time; the Cloudflare Access policy in front is a second, independent check.
 */
export function createTriggerHandler(options: TriggerHandlerOptions) {
  const { config, daemon, log } = options;
  const expectedToken =
    'tokenDigest' in config ? Buffer.from(config.tokenDigest, 'hex') : digest(config.token);
  const automationIds = [
    ...new Set(Object.values(config.triggers).map((trigger) => trigger.automationId)),
  ];

  async function findRun(requestId: string) {
    let unavailable: TriggerDaemonError | undefined;
    for (const automationId of automationIds) {
      const result = await daemon.getRun(automationId, requestId);
      if (!result.success) unavailable = result.error;
      else if (result.data) return { kind: 'found' as const, automationId, run: result.data };
    }
    return unavailable
      ? { kind: 'unavailable' as const, error: unavailable }
      : { kind: 'missing' as const };
  }

  async function submit(request: TriggerRequest): Promise<TriggerResponse> {
    const body = await request.readBody();
    if (body.kind === 'too-large') return failure(413, 'payload_too_large');

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return failure(400, 'invalid_json');
    }
    const parsed = submitRequestSchema.safeParse(json);
    if (!parsed.success) return failure(400, 'invalid_request', z.prettifyError(parsed.error));

    const { requestId, trigger, ...rest } = parsed.data;
    const target = Object.hasOwn(config.triggers, trigger) ? config.triggers[trigger] : undefined;
    if (!target) return failure(404, 'unknown_trigger');

    // A retried submission must succeed even when the queue has since filled up.
    const existing = await daemon.getRun(target.automationId, requestId);
    if (!existing.success) return unavailable(existing.error);
    if (existing.data) return { status: 200, body: requestView(existing.data) };

    const queued = await daemon.queuedCount(target.automationId);
    if (!queued.success) return unavailable(queued.error);
    if (queued.data >= config.maxQueued) return failure(429, 'queue_full');

    const started = await daemon.startRun(target.automationId, { id: requestId, ...rest });
    if (!started.success) {
      if (started.error.type === 'automation-not-found') {
        return failure(404, 'trigger_not_deployed', started.error.message);
      }
      if (started.error.type === 'automation-disabled') {
        return failure(409, 'trigger_disabled', started.error.message);
      }
      return unavailable(started.error);
    }
    return { status: 202, body: requestView(started.data) };
  }

  async function status(requestId: string): Promise<TriggerResponse> {
    const found = await findRun(requestId);
    if (found.kind === 'unavailable') return unavailable(found.error);
    if (found.kind === 'missing') return failure(404, 'request_not_found');
    return { status: 200, body: requestView(found.run) };
  }

  async function cancel(requestId: string): Promise<TriggerResponse> {
    const found = await findRun(requestId);
    if (found.kind === 'unavailable') return unavailable(found.error);
    if (found.kind === 'missing') return failure(404, 'request_not_found');
    if (isTerminalStatus(requestView(found.run).status)) return failure(409, 'already_finished');

    const cancelled = await daemon.cancelRun(found.automationId, requestId);
    if (!cancelled.success) return unavailable(cancelled.error);
    const after = await daemon.getRun(found.automationId, requestId);
    return { status: 200, body: requestView(after.success && after.data ? after.data : found.run) };
  }

  async function route(request: TriggerRequest): Promise<TriggerResponse> {
    if (!isAuthorized(request.authorization, expectedToken)) return failure(401, 'unauthorized');

    const segments = request.path.split('?')[0].split('/').filter(Boolean);
    if (request.method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      return (await daemon.healthy())
        ? { status: 200, body: { status: 'ok' } }
        : failure(503, 'daemon_unavailable');
    }
    if (segments[0] !== 'v1' || segments[1] !== 'requests') return failure(404, 'not_found');

    if (segments.length === 2) {
      return request.method === 'POST' ? submit(request) : failure(405, 'method_not_allowed');
    }
    const requestId = segments[2];
    if (!UUID_PATTERN.test(requestId)) return failure(400, 'invalid_request_id');
    if (segments.length === 3) {
      return request.method === 'GET' ? status(requestId) : failure(405, 'method_not_allowed');
    }
    if (segments.length === 4 && segments[3] === 'cancel') {
      return request.method === 'POST' ? cancel(requestId) : failure(405, 'method_not_allowed');
    }
    return failure(404, 'not_found');
  }

  return async (request: TriggerRequest): Promise<TriggerResponse> => {
    let response: TriggerResponse;
    try {
      response = await route(request);
    } catch (error) {
      response = failure(500, 'internal_error', error instanceof Error ? error.message : undefined);
    }
    log?.(logEntry(request, response));
    return response;
  };
}

/** Adapts the handler to `node:http`. */
export function createTriggerRequestListener(options: TriggerHandlerOptions) {
  const handle = createTriggerHandler(options);
  return (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    void handle({
      method: incoming.method ?? 'GET',
      path: incoming.url ?? '/',
      authorization: incoming.headers.authorization,
      readBody: () => readBody(incoming),
    }).then((response) => {
      const payload = JSON.stringify(response.body);
      outgoing.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      outgoing.end(payload);
    });
  };
}

function readBody(
  incoming: IncomingMessage
): Promise<{ kind: 'ok'; text: string } | { kind: 'too-large' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    incoming.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (!settled) resolve({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    });
    incoming.on('error', () => {
      if (!settled) resolve({ kind: 'ok', text: '' });
    });
  });
}

/** Hex SHA-256 of a trigger token, the form a host may persist instead of the token. */
export function triggerTokenDigest(token: string): string {
  return digest(token).toString('hex');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/iu.exec(header?.trim() ?? '');
  // Hashing first gives both sides one length, as timingSafeEqual requires.
  return match !== null && timingSafeEqual(digest(match[1]), expected);
}

function failure(status: number, error: string, message?: string): TriggerResponse {
  return { status, body: { error, ...(message && { message }) } };
}

function unavailable(error: TriggerDaemonError): TriggerResponse {
  return failure(503, 'daemon_unavailable', error.message);
}

function logEntry(request: TriggerRequest, response: TriggerResponse): TriggerLogEntry {
  const body = (response.body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined);
  return {
    method: request.method,
    path: request.path.split('?')[0],
    status: response.status,
    requestId: text('requestId'),
    runId: text('runId'),
    requestStatus: text('status'),
    error: text('error'),
  };
}
