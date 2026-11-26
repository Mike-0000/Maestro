import { err, ok, type Result } from '@emdash/shared';
import { z } from 'zod';
import type { ClientSessionError } from '@core/features/client-mode/api/client-session-contract';
import { maestroHostHeaders } from '@core/primitives/maestro-host/api/endpoint';
import { ownerPairUrl } from '@main/owner-link/endpoints';

// `POST /api/owner/pair`: trades a one-time owner pairing code for this client's device token.

/** The part of `fetch` the pairing call uses; tests substitute it. */
export type OwnerPairFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type OwnerPairing = { deviceId: string; token: string; hostId: string; hostName: string };

const pairResponseSchema = z.object({
  deviceId: z.string().min(1),
  token: z.string().min(1),
  hostId: z.string().min(1),
  hostName: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

export async function pairWithOwnerHost(input: {
  baseUrl: string;
  code: string;
  deviceName: string;
  cfAccess?: { clientId: string; clientSecret: string };
  fetch?: OwnerPairFetch;
  timeoutMs?: number;
}): Promise<Result<OwnerPairing, ClientSessionError>> {
  const send: OwnerPairFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const headers = maestroHostHeaders({ cfAccess: input.cfAccess });
  headers['Accept'] = 'application/json';
  headers['Content-Type'] = 'application/json';
  let status: number;
  let body: unknown;
  try {
    const response = await send(ownerPairUrl(input.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: input.code.trim(), deviceName: input.deviceName }),
      // A gateway's sign-in redirect is an answer in itself; following it would fetch a web page.
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    status = response.status;
    body = await response.json().catch(() => undefined);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return err({
      type: 'unreachable',
      message: timedOut
        ? 'The host did not answer in time. Check the address and that the computer is on.'
        : `Could not reach the host: ${describeFetchError(error)}`,
    });
  }

  const reason = errorResponseSchema.safeParse(body);
  const hostError = reason.success ? reason.data.error : undefined;
  if (status === 200) {
    const pairing = pairResponseSchema.safeParse(body);
    if (pairing.success) return ok(pairing.data);
    return err({ type: 'failed', message: 'The host answered with an unexpected pairing reply.' });
  }
  if (status === 401 || hostError === 'invalid-code') {
    return err({
      type: 'rejected',
      message:
        'The host did not accept that pairing code. Codes are single-use and expire quickly; create a new one on the host.',
    });
  }
  if (status === 429 || hostError === 'rate-limited') {
    return err({
      type: 'rejected',
      message: 'Too many pairing attempts. Wait a minute, then try again with a new code.',
    });
  }
  if (hostError === 'tailscale-required') {
    return err({
      type: 'rejected',
      message:
        'The host only accepts full-access clients over Tailscale. Use its Tailscale address (https://<name>.<tailnet>.ts.net).',
    });
  }
  if (status === 404) {
    return err({
      type: 'unsupported',
      message:
        'That host does not accept full-access clients. Turn on owner access in its remote access settings, and check both computers run the same Maestro build.',
    });
  }
  if (status === 403 || (status >= 300 && status < 400)) {
    return err({
      type: 'rejected',
      message:
        'A gateway in front of the host turned this client away. If the host is behind Cloudflare Access, check the client ID and secret.',
    });
  }
  return err({
    type: 'failed',
    message: `The host could not pair this client (HTTP ${status}${hostError ? `: ${hostError}` : ''}).`,
  });
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch reports "fetch failed" and keeps the useful reason (ECONNREFUSED, ...) in `cause`.
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return error.message;
}
