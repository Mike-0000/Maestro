import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { z } from 'zod';
import type { RemoteAccessPairing } from '@core/features/remote-access/api';
import { OWNER_PATHS } from '@main/owner-link/endpoints';
import type { RemoteDevice, RemoteDeviceStore, RemoteOwnerAccessSettings } from '../device-store';
import { readJsonBody, sendJson, type RemoteAccessRoute } from '../http-server';
import type { PairingCodes } from '../pairing';
import { authorizeOwnerRequest, classifyOwnerRequest, ownerBearerCredential } from './owner-auth';

// Pairing a full-access (owner) client. Two routes, both answering 404 while owner access is off:
//
// - `POST /api/owner/pair` redeems a code from the owner-only `PairingCodes` (never the ordinary
//   one), after the owner network rule, and returns the device credential once.
// - `POST /api/owner/pairing-code` issues such a code without a screen: only over a direct
//   loopback connection and only with the setup token from `<userData>/owner-setup.token`, a
//   file readable by this computer's user alone. That is how a headless host gets its first code.

/** The setup-token file, in the app's data directory. */
export const OWNER_SETUP_TOKEN_FILE = 'owner-setup.token';

const ownerPairRequestSchema = z.object({
  code: z.string().min(1).max(64),
  deviceName: z.string().trim().min(1).max(80),
});

export type OwnerPairingRouteOptions = {
  store: RemoteDeviceStore;
  /** The owner-only code book; ordinary codes live in a different instance. */
  pairing: PairingCodes;
  settings(): RemoteOwnerAccessSettings;
  hostInfo(): { hostId: string; hostName: string };
  /** Directory holding the setup-token file. */
  dataDirectory: string;
  /** Issues a fresh owner code and publishes it. */
  issueCode(): RemoteAccessPairing;
  onPaired(device: RemoteDevice): void;
  logger: Logger;
};

export function createOwnerPairingRoute(options: OwnerPairingRouteOptions): RemoteAccessRoute {
  return async (request, response, url) => {
    const isPair = url.pathname === OWNER_PATHS.pair;
    const isPairingCode = url.pathname === OWNER_PATHS.pairingCode;
    if (!isPair && !isPairingCode) return false;
    // Off means absent: the listener's own 404 answers.
    if (!options.settings().enabled) return false;
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method-not-allowed' });
      return true;
    }
    if (isPair) await handlePair(request, response);
    else await handlePairingCode(request, response);
    return true;
  };

  async function handlePair(
    request: Parameters<RemoteAccessRoute>[0],
    response: Parameters<RemoteAccessRoute>[1]
  ): Promise<void> {
    const decision = authorizeOwnerRequest(request, options.settings());
    if (!decision.ok) {
      options.logger.warn('Owner pairing refused', { reason: decision.reason });
      sendJson(response, 403, { error: decision.reason });
      return;
    }
    const body = ownerPairRequestSchema.safeParse(await readJsonBody(request));
    if (!body.success) {
      sendJson(response, 400, { error: 'invalid-request' });
      return;
    }
    const attempt = options.pairing.redeem(body.data.code);
    if (attempt === 'rate-limited') {
      options.logger.warn('Owner pairing rate limited');
      sendJson(response, 429, { error: 'rate-limited' });
      return;
    }
    if (attempt === 'invalid') {
      options.logger.warn('Owner pairing code rejected', { via: decision.context.via });
      sendJson(response, 401, { error: 'invalid-code' });
      return;
    }
    const { device, credential } = await options.store.addDevice({
      name: body.data.deviceName,
      kind: 'owner',
    });
    options.logger.info('Owner client paired', {
      deviceId: device.id,
      deviceName: device.name,
      via: decision.context.via,
      login: decision.context.login,
    });
    options.onPaired(device);
    const info = options.hostInfo();
    sendJson(response, 200, {
      deviceId: device.id,
      token: credential,
      hostId: info.hostId,
      hostName: info.hostName,
    });
  }

  async function handlePairingCode(
    request: Parameters<RemoteAccessRoute>[0],
    response: Parameters<RemoteAccessRoute>[1]
  ): Promise<void> {
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, { error: 'origin-forbidden' });
      return;
    }
    // Direct loopback only, whatever the Tailscale setting: a relayed request never qualifies.
    if (classifyOwnerRequest(request).via !== 'loopback') {
      options.logger.warn('Owner pairing-code request refused: not a direct loopback connection');
      sendJson(response, 403, { error: 'loopback-only' });
      return;
    }
    const presented = ownerBearerCredential(request);
    if (!(await verifyOwnerSetupToken(options.dataDirectory, presented))) {
      options.logger.warn('Owner pairing-code request refused: wrong setup token');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const issued = options.issueCode();
    options.logger.info('Owner pairing code issued over loopback');
    sendJson(response, 200, issued);
  }
}

/**
 * Creates the setup-token file if it does not exist yet. The file is created exclusively with
 * owner-only permissions and an existing one is never overwritten (a person may have read it).
 */
export async function ensureOwnerSetupToken(dataDirectory: string): Promise<void> {
  const path = join(dataDirectory, OWNER_SETUP_TOKEN_FILE);
  const token = randomBytes(32).toString('base64url');
  try {
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Tighten a file someone created by hand; best effort, meaningless on Windows.
    if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
  }
}

/** Constant-time comparison of a presented setup token with the file's contents. */
export async function verifyOwnerSetupToken(
  dataDirectory: string,
  presented: string | undefined
): Promise<boolean> {
  if (!presented) return false;
  let expected: string;
  try {
    expected = (await readFile(join(dataDirectory, OWNER_SETUP_TOKEN_FILE), 'utf8')).trim();
  } catch {
    return false;
  }
  // A short or empty file is not a token.
  if (expected.length < 16) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
