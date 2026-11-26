import type { IncomingMessage } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';

// Who may speak to the owner endpoints. An owner credential is full control of this computer (it
// reaches terminals and files), so on top of the bearer token the request must come in the way
// the person allowed: through `tailscale serve` from their tailnet, or straight from loopback.

/** The owner-access settings that decide which requests are admitted. */
export type OwnerAuthPolicy = {
  /** Admit only `tailscale serve` (tailnet identity) and direct loopback connections. */
  tailscaleOnly: boolean;
  /** Tailnet logins admitted through `tailscale serve`; empty admits every tailnet user. */
  allowedLogins: readonly string[];
};

/**
 * How a request reached the listener:
 * - `loopback`: a direct connection from this computer that no proxy relayed.
 * - `tailscale`: relayed by `tailscale serve` for a signed-in tailnet user.
 * - `other`: anything else (another tunnel, Funnel, or a direct connection from the network).
 */
export type OwnerRequestVia = 'loopback' | 'tailscale' | 'other';

export type OwnerRequestContext = {
  via: OwnerRequestVia;
  /** The tailnet login `tailscale serve` vouched for; null unless `via` is `tailscale`. */
  login: string | null;
};

export type OwnerAuthRefusal =
  /** A browser page sent the request; owners are never served to a page. */
  | 'origin-forbidden'
  /** The request did not come through `tailscale serve` or direct loopback. */
  | 'tailscale-required'
  /** The tailnet user is not on the allowlist. */
  | 'login-not-allowed';

export type OwnerAuthDecision =
  | { ok: true; context: OwnerRequestContext }
  | { ok: false; reason: OwnerAuthRefusal };

/** Headers `tailscale serve` adds for a tailnet user (it strips any the caller sent). */
const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login';

/**
 * Headers a relaying proxy adds. A loopback connection carrying any of them was relayed, so it is
 * not a direct local connection.
 */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'via',
  'true-client-ip',
  'cf-connecting-ip',
  'cf-ray',
  TAILSCALE_LOGIN_HEADER,
  'tailscale-user-name',
  'tailscale-funnel-request',
] as const;

/**
 * Headers that mark a request as having crossed something other than `tailscale serve`: a
 * Cloudflare tunnel passes caller-supplied headers through, so a forged Tailscale login would
 * survive it; Funnel marks its public requests.
 */
const FOREIGN_RELAY_HEADERS = [
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
  'cf-warp-tag-id',
  'cdn-loop',
  'true-client-ip',
  'tailscale-funnel-request',
] as const;

/**
 * Classifies how the request arrived. Only the socket's peer address and headers that a trusted
 * local relay controls are believed:
 *
 * - The peer must be loopback for any header to count; on a listener bound to a network address,
 *   anyone on that network could otherwise forge them.
 * - `tailscale serve` connects from loopback, replaces `Tailscale-User-Login` with the tailnet
 *   user it authenticated, and records that user's tailnet address as the last
 *   `X-Forwarded-For` hop. Another tunnel (cloudflared) also connects from loopback and passes the
 *   caller's headers along, so a request with any foreign relay header, or whose last forwarding
 *   hop is not a tailnet address, is not treated as Tailscale even if it names a login.
 */
export function classifyOwnerRequest(request: IncomingMessage): OwnerRequestContext {
  const other: OwnerRequestContext = { via: 'other', login: null };
  if (!isLoopbackAddress(request.socket.remoteAddress)) return other;

  const headers = request.headers;
  if (!PROXY_HEADERS.some((name) => headers[name] !== undefined)) {
    return { via: 'loopback', login: null };
  }
  if (FOREIGN_RELAY_HEADERS.some((name) => headers[name] !== undefined)) return other;

  const login = singleHeader(headers[TAILSCALE_LOGIN_HEADER])?.trim();
  if (!login) return other;
  const lastHop = lastForwardedHop(headers['x-forwarded-for']);
  if (!lastHop || !isTailnetAddress(lastHop)) return other;
  return { via: 'tailscale', login };
}

/** Whether a classified request is admitted under the policy. */
export function evaluateOwnerPolicy(
  context: OwnerRequestContext,
  policy: OwnerAuthPolicy
): OwnerAuthRefusal | null {
  if (policy.tailscaleOnly && context.via === 'other') return 'tailscale-required';
  if (context.via === 'tailscale' && policy.allowedLogins.length > 0) {
    const login = context.login?.toLowerCase() ?? '';
    const allowed = policy.allowedLogins.some((entry) => entry.trim().toLowerCase() === login);
    if (!allowed) return 'login-not-allowed';
  }
  return null;
}

/**
 * The full admission check for an owner request, before any credential is looked at: no
 * `Origin` (a browser page always sends one on a WebSocket upgrade and a cross-site POST, and an
 * owner client never does), then the network rule.
 */
export function authorizeOwnerRequest(
  request: IncomingMessage,
  policy: OwnerAuthPolicy
): OwnerAuthDecision {
  if (request.headers.origin !== undefined) return { ok: false, reason: 'origin-forbidden' };
  const context = classifyOwnerRequest(request);
  const refusal = evaluateOwnerPolicy(context, policy);
  return refusal ? { ok: false, reason: refusal } : { ok: true, context };
}

/** The bearer credential of an owner request. Owners never authenticate with a cookie. */
export function ownerBearerCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
  return match?.[1];
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const unmapped = stripMappedPrefix(address);
  if (isIPv4(unmapped)) return unmapped.startsWith('127.');
  return isIPv6(address) && /^(0{0,4}:){7}0{0,3}1$|^::1$/u.test(address);
}

/** Tailscale's address ranges: `100.64.0.0/10` and `fd7a:115c:a1e0::/48`. */
export function isTailnetAddress(address: string): boolean {
  const unmapped = stripMappedPrefix(address);
  if (isIPv4(unmapped)) {
    const [first, second] = unmapped.split('.').map(Number);
    return first === 100 && second !== undefined && second >= 64 && second <= 127;
  }
  if (!isIPv6(address)) return false;
  return /^fd7a:115c:a1e0:/iu.test(address);
}

function stripMappedPrefix(address: string): string {
  return address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

/** The hop the nearest proxy appended: the last entry of the last `X-Forwarded-For` header. */
function lastForwardedHop(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value.join(',') : value;
  if (!joined) return undefined;
  const hops = joined.split(',');
  const last = hops[hops.length - 1]?.trim();
  if (!last) return undefined;
  // Tolerate a bracketed IPv6 hop with a port (`[fd7a::1]:1234`).
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(last);
  return bracketed?.[1] ?? last;
}
