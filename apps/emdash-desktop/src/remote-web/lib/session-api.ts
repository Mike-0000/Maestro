import { z } from 'zod';

// The host's HTTP surface, same origin as the page. Everything else travels over Wire.

const sessionSchema = z.object({
  authenticated: z.boolean(),
  hostId: z.string(),
  hostName: z.string(),
  device: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

const pairedSchema = z.object({
  deviceId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
});

export type PairFailure = 'invalid-code' | 'rate-limited' | 'unreachable';
export type PairResult =
  | { ok: true; deviceId: string; hostId: string; hostName: string }
  | { ok: false; reason: PairFailure };

const REQUEST_TIMEOUT_MS = 10_000;

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

/** Who the host thinks this browser is. Throws when the host cannot be reached. */
export async function fetchSession(): Promise<SessionInfo> {
  const response = await request('/api/session');
  if (!response.ok) throw new Error(`The host answered ${response.status}`);
  return sessionSchema.parse(await response.json());
}

/** Redeems a pairing code; on success the host has set this browser's session cookie. */
export async function pairDevice(code: string, deviceName: string): Promise<PairResult> {
  let response: Response;
  try {
    response = await request('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, kind: 'browser' }),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 401) return { ok: false, reason: 'invalid-code' };
  if (response.status === 429) return { ok: false, reason: 'rate-limited' };
  if (!response.ok) return { ok: false, reason: 'unreachable' };
  const parsed = pairedSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, reason: 'unreachable' };
  return { ok: true, ...parsed.data };
}

/** Clears the cookie and revokes this device on the host. Best effort: it may be offline. */
export async function signOut(): Promise<boolean> {
  try {
    const response = await request('/api/signout', { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}
