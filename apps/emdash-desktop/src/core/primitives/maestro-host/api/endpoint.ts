import { err, ok, type Result } from '@emdash/shared';

/**
 * Addresses and request headers for the Maestro app on another computer ("Maestro host"). Every
 * request to a host — the pairing calls and the Wire WebSocket alike — is built here, so the
 * endpoint paths and the credential headers have exactly one definition.
 */

export type MaestroHostUrlError = { type: 'invalid-url'; message: string };

/** Plaintext credentials for one request. Callers disclose their `Secret`s only to build this. */
export type MaestroHostRequestCredentials = {
  /** Device token issued by pairing; absent for the unauthenticated info and pair calls. */
  token?: string;
  /** Cloudflare Access service token, when the host sits behind Cloudflare Access. */
  cfAccess?: { clientId: string; clientSecret: string };
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_PROTOCOLS: Record<string, 'http:' | 'https:' | undefined> = {
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:',
};

/**
 * Canonical base URL for a host: scheme, host, optional port, and optional path prefix, with no
 * trailing slash. A bare address gets `https://`, or `http://` for this computer's loopback.
 */
export function normalizeMaestroHostUrl(input: string): Result<string, MaestroHostUrlError> {
  const trimmed = input.trim();
  if (!trimmed) return invalid('Enter the address of the Maestro host.');
  const candidate = SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `${defaultScheme(trimmed)}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return invalid(`"${trimmed}" is not a valid address.`);
  }
  const protocol = HTTP_PROTOCOLS[url.protocol];
  if (!protocol) return invalid('The address must start with http:// or https://.');
  if (!url.hostname) return invalid(`"${trimmed}" is not a valid address.`);
  if (url.username || url.password) {
    return invalid('Remove the user name and password from the address.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return ok(`${protocol}//${url.host}${path}`);
}

export function maestroHostInfoUrl(baseUrl: string): string {
  return `${baseUrl}/api/info`;
}

export function maestroHostPairUrl(baseUrl: string): string {
  return `${baseUrl}/api/pair`;
}

/** The Wire endpoint: the same origin and path prefix, over `ws://` or `wss://`. */
export function maestroHostWireUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/wire`;
}

/** Host name and port, for display and for the machine row's address columns. */
export function maestroHostAddress(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host: url.hostname, port };
}

/** Headers every request to the host carries for the given credentials. */
export function maestroHostHeaders(
  credentials: MaestroHostRequestCredentials = {}
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credentials.token) headers['Authorization'] = `Bearer ${credentials.token}`;
  if (credentials.cfAccess) {
    headers['CF-Access-Client-Id'] = credentials.cfAccess.clientId;
    headers['CF-Access-Client-Secret'] = credentials.cfAccess.clientSecret;
  }
  return headers;
}

function defaultScheme(address: string): 'http' | 'https' {
  const authority = address.split('/')[0] ?? '';
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(host) ? 'http' : 'https';
}

function invalid(message: string): Result<string, MaestroHostUrlError> {
  return err({ type: 'invalid-url', message });
}
