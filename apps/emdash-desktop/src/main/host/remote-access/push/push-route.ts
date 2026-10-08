import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { RemoteDevice, RemoteDeviceStore } from '../device-store';
import {
  readJsonBody,
  sameOrigin,
  sendJson,
  sessionCredential,
  type RemoteAccessRoute,
} from '../http-server';
import type { PushDispatcher } from './push-dispatcher';
import { pushEventsSchema, type PushStore } from './push-store';
import { parsePushEndpoint, validSubscriptionKeys } from './web-push';

const TEST_INTERVAL_MS = 5_000;

const subscriptionRequestSchema = z.object({
  endpoint: z.string().min(1).max(1024),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  events: pushEventsSchema,
});

/**
 * `/api/push`: how a paired phone's page turns notifications on and off for itself. Only a
 * browser device's own session cookie is accepted, and every change must come from this
 * origin's page.
 */
export function createPushRoute(options: {
  devices: Pick<RemoteDeviceStore, 'authenticate'>;
  store: PushStore;
  dispatcher: Pick<PushDispatcher, 'sendTest'>;
  /** The app-wide notifications switch. */
  notificationsEnabled(): Promise<boolean>;
  now?: () => number;
}): RemoteAccessRoute {
  const now = options.now ?? Date.now;
  const lastTestAt = new Map<string, number>();

  function authorize(request: IncomingMessage, response: ServerResponse): RemoteDevice | undefined {
    const device = options.devices.authenticate(sessionCredential(request));
    if (device?.kind !== 'browser') {
      sendJson(response, 401, { error: 'unauthorized' });
      return undefined;
    }
    // Cookies travel on their own, so a request that changes something must prove its origin.
    if (request.method !== 'GET' && !sameOrigin(request)) {
      sendJson(response, 403, { error: 'cross-origin' });
      return undefined;
    }
    return device;
  }

  async function describe(device: RemoteDevice, response: ServerResponse): Promise<void> {
    const [vapid, subscription, hostEnabled] = await Promise.all([
      options.store.vapid(),
      // Unreadable storage shows up as `available: false`, not as a failed request.
      options.store.get(device.id).catch(() => undefined),
      options.notificationsEnabled(),
    ]);
    sendJson(response, 200, {
      available: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
      hostEnabled,
      subscription: subscription ? { events: subscription.events } : null,
    });
  }

  async function subscribe(
    device: RemoteDevice,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = subscriptionRequestSchema.safeParse(await readJsonBody(request));
    if (!body.success || !validSubscriptionKeys(body.data.keys.p256dh, body.data.keys.auth)) {
      sendJson(response, 400, { error: 'invalid-request' });
      return;
    }
    // The host posts to this address later; it may only ever be the known push service.
    if (!parsePushEndpoint(body.data.endpoint)) {
      sendJson(response, 422, { error: 'unsupported-push-service' });
      return;
    }
    if (!(await options.store.vapid())) {
      sendJson(response, 503, { error: 'unavailable' });
      return;
    }
    await options.store.upsert(device.id, {
      endpoint: body.data.endpoint,
      p256dh: body.data.keys.p256dh,
      auth: body.data.keys.auth,
      events: body.data.events,
      updatedAt: now(),
    });
    sendNoContent(response);
  }

  async function test(device: RemoteDevice, response: ServerResponse): Promise<void> {
    const last = lastTestAt.get(device.id);
    if (last !== undefined && now() - last < TEST_INTERVAL_MS) {
      sendJson(response, 429, { error: 'rate-limited' });
      return;
    }
    lastTestAt.set(device.id, now());
    if (!(await options.notificationsEnabled())) {
      sendJson(response, 200, { ok: false, reason: 'host-disabled' });
      return;
    }
    sendJson(response, 200, await options.dispatcher.sendTest(device.id));
  }

  return async (request, response, url) => {
    const { pathname } = url;
    const { method } = request;
    const matched =
      (pathname === '/api/push' && method === 'GET') ||
      (pathname === '/api/push/subscription' && (method === 'PUT' || method === 'DELETE')) ||
      (pathname === '/api/push/test' && method === 'POST');
    if (!matched) return false;

    const device = authorize(request, response);
    if (!device) return true;

    if (pathname === '/api/push') await describe(device, response);
    else if (pathname === '/api/push/test') await test(device, response);
    else if (method === 'PUT') await subscribe(device, request, response);
    else {
      await options.store.remove(device.id);
      sendNoContent(response);
    }
    return true;
  };
}

function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}
