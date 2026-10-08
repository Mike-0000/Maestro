import { z } from 'zod';

// The host's push-notification routes, same origin as the page.

const eventsSchema = z.object({ complete: z.boolean(), attention: z.boolean() });
export type PushEvents = z.infer<typeof eventsSchema>;

const stateSchema = z.object({
  /** False when the host cannot keep a push key securely; push is then off altogether. */
  available: z.boolean(),
  publicKey: z.string().nullable(),
  /** The notifications switch in Maestro on the computer. */
  hostEnabled: z.boolean(),
  subscription: z.object({ events: eventsSchema }).nullable(),
});
export type HostPushState = z.infer<typeof stateSchema>;

const testSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type PushSaveFailure = 'unsupported-push-service' | 'unavailable' | 'unreachable';
export type PushTestFailure =
  | 'not-subscribed'
  | 'unavailable'
  | 'expired'
  | 'failed'
  | 'host-disabled'
  | 'rate-limited'
  | 'unreachable';

const REQUEST_TIMEOUT_MS = 15_000;

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
  });
}

/** What the host knows about this device's notifications. Throws when it cannot be reached. */
export async function fetchPushState(): Promise<HostPushState> {
  const response = await request('/api/push');
  if (!response.ok) throw new Error(`The host answered ${response.status}`);
  return stateSchema.parse(await response.json());
}

/** Registers (or replaces) this device's subscription and the events it wants. */
export async function savePushSubscription(
  subscription: PushSubscriptionJSON,
  events: PushEvents
): Promise<PushSaveFailure | undefined> {
  try {
    const response = await request('/api/push/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys, events }),
    });
    if (response.ok) return undefined;
    if (response.status === 422) return 'unsupported-push-service';
    return response.status === 503 ? 'unavailable' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** Best effort: the host may be offline, and it forgets unpaired devices on its own. */
export async function removePushSubscription(): Promise<boolean> {
  try {
    return (await request('/api/push/subscription', { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

export async function sendTestPush(): Promise<PushTestFailure | undefined> {
  try {
    const response = await request('/api/push/test', { method: 'POST' });
    if (response.status === 429) return 'rate-limited';
    if (!response.ok) return 'unreachable';
    const result = testSchema.parse(await response.json());
    return result.ok ? undefined : (result.reason as PushTestFailure);
  } catch {
    return 'unreachable';
  }
}
