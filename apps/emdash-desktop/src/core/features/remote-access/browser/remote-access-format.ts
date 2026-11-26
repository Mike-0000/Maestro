import type {
  RemoteAccessDevice,
  RemoteAccessStatus,
  RemoteAccessTailscale,
} from '@core/features/remote-access/api';

export const REMOTE_ACCESS_MIN_PORT = 1024;
export const REMOTE_ACCESS_MAX_PORT = 65535;

export type ListenerStateLine = {
  tone: 'neutral' | 'success' | 'error';
  text: string;
};

type ListenerState = Pick<
  RemoteAccessStatus,
  'enabled' | 'listening' | 'port' | 'bindAddress' | 'error'
>;

/** `host:port`, with an IPv6 host bracketed so the port stays unambiguous. */
export function formatListenerAddress(bindAddress: string, port: number): string {
  const host = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress;
  return `${host}:${port}`;
}

/** The one-line state shown under the main switch. */
export function listenerStateLine(status: ListenerState | undefined): ListenerStateLine {
  if (!status) return { tone: 'neutral', text: 'Checking…' };
  if (!status.enabled) return { tone: 'neutral', text: 'Off' };
  if (status.listening) {
    return {
      tone: 'success',
      text: `Listening on ${formatListenerAddress(status.bindAddress, status.port)}`,
    };
  }
  if (status.error) return { tone: 'error', text: status.error };
  return { tone: 'neutral', text: 'Starting…' };
}

/** Time left until `expiresAt` as `m:ss`, never below `0:00`. */
export function formatCountdown(expiresAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function deviceKindLabel(kind: RemoteAccessDevice['kind']): string {
  if (kind === 'owner') return 'Maestro client';
  return kind === 'desktop' ? 'Maestro app' : 'Phone or browser';
}

export type DeviceActivity =
  | { kind: 'connected' }
  | { kind: 'last-seen'; at: number }
  | { kind: 'never' };

export function deviceActivity(
  device: Pick<RemoteAccessDevice, 'connections' | 'lastSeenAt'>
): DeviceActivity {
  if (device.connections > 0) return { kind: 'connected' };
  if (device.lastSeenAt === null) return { kind: 'never' };
  return { kind: 'last-seen', at: device.lastSeenAt };
}

/** Connected devices first, then the most recently seen, then the most recently paired. */
export function sortDevices<T extends RemoteAccessDevice>(devices: readonly T[]): T[] {
  return [...devices].sort((a, b) => {
    const connected = Number(b.connections > 0) - Number(a.connections > 0);
    if (connected !== 0) return connected;
    const seen = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    if (seen !== 0) return seen;
    return b.createdAt - a.createdAt;
  });
}

export type PortInput = { ok: true; port: number } | { ok: false; message: string };

export function parsePortInput(text: string): PortInput {
  const trimmed = text.trim();
  const port = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || port < REMOTE_ACCESS_MIN_PORT || port > REMOTE_ACCESS_MAX_PORT) {
    return {
      ok: false,
      message: `Enter a port between ${REMOTE_ACCESS_MIN_PORT} and ${REMOTE_ACCESS_MAX_PORT}.`,
    };
  }
  return { ok: true, port };
}

export type TailscaleStage = 'missing' | 'signed-out' | 'ready' | 'serving';

export function tailscaleStage(
  tailscale: Pick<RemoteAccessTailscale, 'available' | 'running' | 'serving' | 'url'>
): TailscaleStage {
  if (!tailscale.available) return 'missing';
  if (!tailscale.running) return 'signed-out';
  // Without an address there is nothing to hand to the other device yet.
  return tailscale.serving && tailscale.url ? 'serving' : 'ready';
}

/**
 * Where another service sends on-demand agent requests: the Tailscale HTTPS address once
 * it is serving, otherwise the listener itself (reachable from this computer only).
 */
export function requestsEndpoint(
  status: Pick<RemoteAccessStatus, 'bindAddress' | 'port'>,
  tailscale: Pick<RemoteAccessTailscale, 'available' | 'running' | 'serving' | 'url'> | undefined
): string {
  const base =
    tailscale && tailscaleStage(tailscale) === 'serving' && tailscale.url
      ? tailscale.url.replace(/\/+$/u, '')
      : `http://${formatListenerAddress(status.bindAddress, status.port)}`;
  return `${base}/v1/requests`;
}

export const OWNER_ALLOWED_LOGINS_MAX = 64;

export type AllowedLoginsInput = { ok: true; logins: string[] } | { ok: false; message: string };

/**
 * The tailnet logins typed into the full-access allowlist: separated by commas, spaces or new
 * lines, compared without regard to case, each kept once in the order given.
 */
export function parseAllowedLogins(text: string): AllowedLoginsInput {
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/u)) {
    const login = part.trim();
    if (!login) continue;
    if (login.length > 256) {
      return { ok: false, message: 'A login can be at most 256 characters long.' };
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  if (logins.length > OWNER_ALLOWED_LOGINS_MAX) {
    return { ok: false, message: `Enter at most ${OWNER_ALLOWED_LOGINS_MAX} logins.` };
  }
  return { ok: true, logins };
}

export function formatAllowedLogins(logins: readonly string[]): string {
  return logins.join(', ');
}

/** `Windows`, `macOS`, `Linux` for a Node platform name; the name itself when it is another. */
export function clientPlatformLabel(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}
