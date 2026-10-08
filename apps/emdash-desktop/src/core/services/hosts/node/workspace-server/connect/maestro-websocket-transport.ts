import type { Secret } from '@emdash/shared';
import { connectWebSocket, WebSocketHandshakeError } from '@emdash/wire/node';
import type { WireTransport } from '@emdash/wire/rpc';
import { maestroHostHeaders, maestroHostWireUrl } from '@core/primitives/maestro-host/api/endpoint';
import {
  MAESTRO_HOST_CLOUDFLARE_MESSAGE,
  MAESTRO_HOST_NOT_PAIRED_MESSAGE,
} from '@core/primitives/maestro-host/api/messages';
import { SshConnectionFailure } from '@core/primitives/ssh/api/node/connection-control';
import type { MaestroWorkspaceServerTarget } from '../../../api/targets';

/** What dialing one Maestro host needs. Secrets stay wrapped until the request is built. */
export type MaestroHostDialConfig = {
  /** Normalised base URL, as stored in the machine's metadata. */
  url: string;
  /** Device token issued by pairing; null once the machine has lost it. */
  token: Secret<string> | null;
  cfAccess?: { clientId: string; clientSecret: Secret<string> };
};

export type MaestroHostConnectPort = {
  /** Reads the machine's current address and credentials. Called for every dial. */
  resolve(connectionId: string): Promise<MaestroHostDialConfig>;
  /** Substituted in tests; production dials a real WebSocket. */
  dial?: typeof connectWebSocket;
};

export type MaestroHostConnectionErrorCode =
  /** The host no longer accepts this device's token (revoked, or never paired). */
  | 'not-paired'
  /** Cloudflare Access rejected the service token before the request reached the host. */
  | 'cloudflare-access'
  /** The machine has no usable address. */
  | 'not-configured'
  /** The host did not answer or refused for another reason; worth retrying. */
  | 'unreachable';

/**
 * A failed dial of a Maestro host. It shares the SSH failure kinds so the Host supervisor's
 * existing policy applies unchanged: credential and configuration failures stop automatic
 * retries with this message, and transport failures back off and retry.
 */
export class MaestroHostConnectionError extends SshConnectionFailure {
  readonly name = 'MaestroHostConnectionError';

  constructor(
    readonly code: MaestroHostConnectionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(
      code === 'unreachable'
        ? 'transport'
        : code === 'not-configured'
          ? 'configuration'
          : 'authentication',
      message,
      options
    );
  }
}

export async function openMaestroWorkspaceServerTransport(
  target: MaestroWorkspaceServerTarget,
  port: MaestroHostConnectPort,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<WireTransport> {
  const config = await port.resolve(target.connectionId);
  options?.signal?.throwIfAborted();
  if (!config.token)
    throw new MaestroHostConnectionError('not-paired', MAESTRO_HOST_NOT_PAIRED_MESSAGE);
  try {
    return await (port.dial ?? connectWebSocket)({
      url: maestroHostWireUrl(config.url),
      // Boundary disclosure: the credentials leave their Secrets only as request headers.
      headers: maestroHostHeaders({
        token: config.token.expose(),
        cfAccess: config.cfAccess && {
          clientId: config.cfAccess.clientId,
          clientSecret: config.cfAccess.clientSecret.expose(),
        },
      }),
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  } catch (cause) {
    if (options?.signal?.aborted) throw cause;
    throw maestroHostDialError(cause);
  }
}

function maestroHostDialError(cause: unknown): MaestroHostConnectionError {
  if (cause instanceof MaestroHostConnectionError) return cause;
  if (cause instanceof WebSocketHandshakeError) {
    if (cause.statusCode === 401) {
      return new MaestroHostConnectionError('not-paired', MAESTRO_HOST_NOT_PAIRED_MESSAGE, {
        cause,
      });
    }
    if (cause.statusCode === 403) {
      return new MaestroHostConnectionError('cloudflare-access', MAESTRO_HOST_CLOUDFLARE_MESSAGE, {
        cause,
      });
    }
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MaestroHostConnectionError(
    'unreachable',
    `Could not reach the Maestro host: ${detail}`,
    { cause }
  );
}
