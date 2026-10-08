import { err, ok, secret, type Result, type Secret } from '@emdash/shared';
import { z } from 'zod';
import {
  maestroHostHeaders,
  maestroHostInfoUrl,
  maestroHostPairUrl,
} from '@core/primitives/maestro-host/api/endpoint';
import type { MaestroHostError, MaestroHostErrorType } from '../api/maestro-host';

/** The part of `fetch` this client uses; tests substitute it. */
export type MaestroHostFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type MaestroHostCfAccess = { clientId: string; clientSecret: Secret<string> };

export type MaestroHostIdentity = { hostId: string; hostName: string; protocolVersion: string };

export type MaestroHostPairing = {
  deviceId: string;
  token: Secret<string>;
  hostId: string;
  hostName: string;
};

export type MaestroHostClient = {
  /** `GET /api/info`: who answers at this address. No device token is involved. */
  info(
    baseUrl: string,
    cfAccess?: MaestroHostCfAccess
  ): Promise<Result<MaestroHostIdentity, MaestroHostError>>;
  /** `POST /api/pair`: trades a one-time pairing code for this device's token. */
  pair(
    baseUrl: string,
    request: { code: string; deviceName: string },
    cfAccess?: MaestroHostCfAccess
  ): Promise<Result<MaestroHostPairing, MaestroHostError>>;
};

const infoResponseSchema = z.object({
  app: z.literal('maestro'),
  hostId: z.string().min(1),
  hostName: z.string(),
  protocolVersion: z.string(),
});

const pairResponseSchema = z.object({
  deviceId: z.string().min(1),
  token: z.string().min(1),
  hostId: z.string().min(1),
  hostName: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

const NOT_MAESTRO_HOST_MESSAGE =
  'That address did not answer as a Maestro host. Check the address, and that remote access is turned on in Maestro on that computer.';
const CLOUDFLARE_MESSAGE =
  'The host is behind Cloudflare Access and turned this device away. Check the Cloudflare Access client ID and client secret.';

export function createMaestroHostClient(
  options: { fetch?: MaestroHostFetch; timeoutMs?: number } = {}
): MaestroHostClient {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  const request = async (
    url: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    cfAccess: MaestroHostCfAccess | undefined
  ): Promise<Result<{ status: number; body: unknown }, MaestroHostError>> => {
    // Boundary disclosure: the Cloudflare secret leaves its Secret only as a request header.
    const headers = maestroHostHeaders({
      cfAccess: cfAccess && {
        clientId: cfAccess.clientId,
        clientSecret: cfAccess.clientSecret.expose(),
      },
    });
    headers['Accept'] = 'application/json';
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await send(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // A gateway's sign-in redirect is an answer in itself; following it would fetch a web page.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return ok({ status: response.status, body: await response.json().catch(() => undefined) });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return failure(
        'unreachable',
        timedOut
          ? 'The host did not answer in time. Check the address and that the computer is on.'
          : `Could not reach the host: ${describeFetchError(error)}`
      );
    }
  };

  return {
    async info(baseUrl, cfAccess) {
      const response = await request(maestroHostInfoUrl(baseUrl), { method: 'GET' }, cfAccess);
      if (!response.success) return response;
      const { status, body } = response.data;
      if (isGatewayRefusal(status)) return failure('cloudflare-access', CLOUDFLARE_MESSAGE);
      const info = infoResponseSchema.safeParse(body);
      if (status !== 200 || !info.success) {
        return failure('not-maestro-host', NOT_MAESTRO_HOST_MESSAGE);
      }
      return ok({
        hostId: info.data.hostId,
        hostName: info.data.hostName,
        protocolVersion: info.data.protocolVersion,
      });
    },

    async pair(baseUrl, { code, deviceName }, cfAccess) {
      const response = await request(
        maestroHostPairUrl(baseUrl),
        { method: 'POST', body: { code, deviceName, kind: 'desktop' } },
        cfAccess
      );
      if (!response.success) return response;
      const { status, body } = response.data;
      const reason = errorResponseSchema.safeParse(body);
      const hostError = reason.success ? reason.data.error : undefined;
      if (status === 401 || hostError === 'invalid-code') {
        return failure(
          'invalid-code',
          'The host did not accept that pairing code. Codes are single-use and expire quickly; create a new one in Maestro on that computer.'
        );
      }
      if (status === 429 || hostError === 'rate-limited') {
        return failure(
          'rate-limited',
          'Too many pairing attempts. Wait a minute, then try again with a new code.'
        );
      }
      if (isGatewayRefusal(status)) return failure('cloudflare-access', CLOUDFLARE_MESSAGE);
      const pairing = pairResponseSchema.safeParse(body);
      if (status !== 200 || !pairing.success) {
        return failure(
          'failed',
          `The host could not pair this device (HTTP ${status}${hostError ? `: ${hostError}` : ''}).`
        );
      }
      return ok({
        deviceId: pairing.data.deviceId,
        token: secret(pairing.data.token, 'maestro-host-device-token'),
        hostId: pairing.data.hostId,
        hostName: pairing.data.hostName,
      });
    },
  };
}

/** A redirect (to a sign-in page) or a 403 comes from a gateway in front of the host. */
function isGatewayRefusal(status: number): boolean {
  return status === 403 || (status >= 300 && status < 400);
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch reports "fetch failed" and keeps the useful reason (ECONNREFUSED, …) in `cause`.
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return error.message;
}

function failure(type: MaestroHostErrorType, message: string): Result<never, MaestroHostError> {
  return err({ type, message });
}
