import { describeBuild, type BuildIdentity } from '../api/build-identity';
import type { ClientSessionError, ClientSessionStatus } from '../api/client-session-contract';
import type { HostUpdateError } from '../api/host-update';

/** A link slower than this reads as a warning in the title bar. */
export const SLOW_LINK_MS = 300;

/** Where full access lives on the host; the separators do not wrap away from their words. */
export const SETTINGS_PATH = 'Settings\u00a0›\u00a0Remote access';

/** How long a dropped link stays a quiet banner before the window is blocked. */
export const RECONNECT_GRACE_MS = 5000;

type HostRef = ClientSessionStatus['host'];

/** The host's address without its scheme or trailing slash, as a person would say it. */
export function hostAddressLabel(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
    .replace(/\/+$/u, '');
}

/** What to call the host in a sentence: its name, else its address, else "the host". */
export function hostLabel(host: HostRef): string {
  if (!host) return 'the host';
  const name = host.name.trim();
  if (name) return name;
  return hostAddressLabel(host.url) || 'the host';
}

/** `24 ms`, `<1 ms`, `1.2 s`; null while the link has not been measured. */
export function formatLatency(latencyMs: number | null): string | null {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs < 0) return null;
  if (latencyMs < 1) return '<1 ms';
  if (latencyMs < 1000) return `${Math.round(latencyMs)} ms`;
  return `${(latencyMs / 1000).toFixed(1)} s`;
}

export type LinkTone = 'steady' | 'slow' | 'working' | 'down';

/** The one mark the title bar shows for the link. */
export function linkTone(status: ClientSessionStatus): LinkTone {
  if (status.phase === 'connected') {
    return status.latencyMs !== null && status.latencyMs >= SLOW_LINK_MS ? 'slow' : 'steady';
  }
  if (status.phase === 'connecting' || status.phase === 'reconnecting') return 'working';
  return 'down';
}

/** The link's state in a few words, for the title bar's accessible name and menu. */
export function linkStateLabel(status: ClientSessionStatus): string {
  switch (status.phase) {
    case 'connected': {
      const latency = formatLatency(status.latencyMs);
      return latency ? `Connected, ${latency}` : 'Connected';
    }
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'blocked':
      return 'Not connected';
    case 'unpaired':
      return 'Not paired';
  }
}

export type PairFields = {
  url: string;
  code: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
};

/** What is missing from the pairing form, in the words shown under it; null when complete. */
export function validatePairFields(fields: PairFields): string | null {
  if (!fields.url.trim()) return 'Enter the address of the Maestro host.';
  if (!fields.code.trim()) return 'Enter the pairing code shown by the host.';
  const id = fields.cfAccessClientId.trim();
  const secret = fields.cfAccessClientSecret.trim();
  if (id && !secret) return 'Enter the Cloudflare Access client secret, or clear the client ID.';
  if (secret && !id) return 'Enter the Cloudflare Access client ID, or clear the client secret.';
  return null;
}

/** The next thing to try after a failed pairing, by what went wrong. */
export function pairErrorHint(type: ClientSessionError['type']): string | null {
  switch (type) {
    case 'unreachable':
      return 'Check the address, and that this computer is on the same private network as the host.';
    case 'invalid':
      return 'Codes work once and expire after 10 minutes. Create a new full-access code on the host.';
    case 'rejected':
      return 'The host refused this client. Check that full access is turned on there and that your network is allowed.';
    case 'unsupported':
      return 'That host does not offer full access. Update Maestro on the host, then turn on full access.';
    case 'failed':
      return null;
  }
}

/** What to do after the host declined to update itself. */
export function hostUpdateErrorHint(type: HostUpdateError['type']): string | null {
  switch (type) {
    case 'unsupported':
      return 'Update Maestro on the host by hand, or update this client instead.';
    case 'no-update':
      return 'The host has no newer build to install. Update this client instead.';
    case 'failed':
      return null;
  }
}

/** Leading numeric parts of a version (`1.4.2-beta.1` gives `[1, 4, 2]`); null when there are none. */
function versionParts(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/u.exec(version.trim());
  if (!match) return null;
  return match[1]!.split('.').map(Number);
}

/**
 * Which side runs the older build, judged by version number alone. Null when it cannot be told:
 * equal versions from different commits, or a version that is not a dotted number.
 */
export function olderSide(
  clientBuild: BuildIdentity | undefined,
  hostBuild: BuildIdentity | undefined
): 'client' | 'host' | null {
  if (!clientBuild || !hostBuild) return null;
  const client = versionParts(clientBuild.version);
  const host = versionParts(hostBuild.version);
  if (!client || !host) return null;
  const length = Math.max(client.length, host.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (client[index] ?? 0) - (host[index] ?? 0);
    if (difference < 0) return 'client';
    if (difference > 0) return 'host';
  }
  return null;
}

/** A build for display, or a placeholder when the other side did not report one. */
export function buildLabel(build: BuildIdentity | undefined): string {
  return build ? describeBuild(build) : 'Unknown';
}

export type BlockedCopy = { title: string; description: string };

/** The headline and one sentence for a blocked link: what happened and what to do next. */
export function blockedCopy(status: ClientSessionStatus): BlockedCopy {
  const host = hostLabel(status.host);
  const other = status.blocked?.busyClientName?.trim() || 'Another Maestro client';
  switch (status.blocked?.reason) {
    case 'build-mismatch':
      return {
        title: `This client and ${host} run different builds`,
        description:
          'Both sides must run the same build of Maestro. Update the one that is behind and this client connects by itself.',
      };
    case 'revoked':
      return {
        title: `This client was removed from ${host}`,
        description:
          'Its pairing was removed on the host. To keep using it, create a new full-access code there and pair again.',
      };
    case 'owner-disabled':
      return {
        title: `Full access is turned off on ${host}`,
        description: `In Maestro on the host, open ${SETTINGS_PATH} and turn on "Allow a full-access client". Then try again.`,
      };
    case 'busy':
      return {
        title: `${host} is in use by another client`,
        description: `${other} is connected. A host works with one client at a time. Taking over disconnects the other client; its agents keep running.`,
      };
    case 'superseded':
      return {
        title: `Another client took over ${host}`,
        description: `${other} connected, so this window was disconnected. Nothing is lost: the agents keep running on the host.`,
      };
    case 'tailscale-required':
      return {
        title: `${host} only accepts clients over Tailscale`,
        description:
          "Connect this computer to the same tailnet and use the host's Tailscale address, or allow other networks in the host's full-access settings.",
      };
    case undefined:
      return {
        title: `Not connected to ${host}`,
        description: 'The host did not say why. Try again, or pair this client again.',
      };
  }
}

/** `Attempt 3` once the link has retried at least once; null before that. */
export function attemptLabel(attempt: number): string | null {
  return attempt > 0 ? `Attempt ${attempt}` : null;
}

/**
 * The command that issues a full-access pairing code on a host without a screen. It runs on the
 * host itself: the endpoint answers only direct loopback requests carrying the setup token.
 */
export function headlessPairingCommand(port = 7462): string {
  return `curl -s -X POST -H "Authorization: Bearer $(cat ~/.config/chorus/owner-setup.token)" http://127.0.0.1:${port}/api/owner/pairing-code`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
