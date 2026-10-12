/**
 * Pure policy for model-driven browsing: which URLs a conductor or agent may load, and how often
 * it may act. The main process applies it to every automation call and to navigations the page
 * starts on its own while a model holds control.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
]);

/** Hosts that are never the public internet, whatever they resolve to. */
const PRIVATE_HOST_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
  '.test',
  '.invalid',
];

export type PublicUrlDenialReason =
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'insecure-public-url'
  | 'embedded-credentials'
  | 'not-public-host';

export type PublicUrlDecision =
  | { ok: true; origin: string }
  | { ok: false; reason: PublicUrlDenialReason };

export type NavigationDecision =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'invalid-url'
        | 'unsupported-protocol'
        | 'origin-not-allowed'
        | 'reserved-port'
        | 'insecure-public-url'
        | 'embedded-credentials'
        | 'public-web-disabled'
        | 'public-origin-not-approved';
    };

export type NavigationPolicy = {
  /** Origins the model may load, e.g. the task's dev-server origins plus user-approved extras. */
  allowedOrigins: readonly string[];
  /** Loopback ports that belong to Chorus itself (hook, credential, control servers). */
  reservedPorts: readonly number[];
  /**
   * Public websites for this actor. Absent means the actor never gets them (coding agents).
   * `disabled` is the conductor with the setting off; otherwise the public origins the user
   * approved for this browser.
   */
  publicWeb?: 'disabled' | { approvedOrigins: readonly string[] };
};

export type HostKind = 'loopback' | 'private' | 'public';

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function isPrivateIpv4(host: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Where a URL hostname (as `URL.hostname` reports it) lives. Anything that is not clearly the
 * public internet counts as private: RFC 1918 and link-local addresses (cloud metadata),
 * carrier-grade NAT, every IPv6 literal outside global unicast, single-label names and
 * intranet suffixes. Names are judged as written; DNS is not consulted.
 */
export function classifyHost(hostname: string): HostKind {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isLoopbackHost(host)) return 'loopback';
  if (host.startsWith('[')) {
    // Global unicast is 2000::/3; mapped, ULA, link-local, NAT64 and multicast all fall outside.
    return /^\[[23][0-9a-f]{3}:/.test(host) ? 'public' : 'private';
  }
  const privateIpv4 = isPrivateIpv4(host);
  if (privateIpv4 !== null) return privateIpv4 ? 'private' : 'public';
  if (!host.includes('.')) return 'private';
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private';
  return 'public';
}

/**
 * Whether a URL is a public website a model may be sent to at all, before any user approval:
 * https only, no credentials in the URL, and a host on the public internet.
 */
export function evaluatePublicUrl(rawUrl: string): PublicUrlDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-protocol' };
  }
  if (classifyHost(url.hostname) !== 'public') return { ok: false, reason: 'not-public-host' };
  if (url.username || url.password) return { ok: false, reason: 'embedded-credentials' };
  if (url.protocol !== 'https:') return { ok: false, reason: 'insecure-public-url' };
  return { ok: true, origin: url.origin };
}

export function describePublicUrlDenial(reason: PublicUrlDenialReason, url: string): string {
  switch (reason) {
    case 'invalid-url':
      return `"${url}" is not a valid URL.`;
    case 'unsupported-protocol':
      return `Only http and https pages can be opened (${url}).`;
    case 'insecure-public-url':
      return `${url} is not https. Public websites are only opened over https.`;
    case 'embedded-credentials':
      return 'URLs that carry a username or password are not opened.';
    case 'not-public-host':
      return `${url} is on a private network, not the public internet. Only this machine's apps and public https sites can be opened.`;
  }
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Canonical comparison key for an origin. Loopback aliases (localhost, 127.0.0.1, [::1], 0.0.0.0)
 * share one key so a dev server detected as `localhost:5173` also admits `127.0.0.1:5173`.
 */
export function originKey(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = isLoopbackHost(url.hostname) ? 'loopback' : url.hostname.toLowerCase();
  return `${url.protocol}//${host}:${effectivePort(url)}`;
}

export function evaluateNavigation(rawUrl: string, policy: NavigationPolicy): NavigationDecision {
  if (rawUrl === 'about:blank') return { ok: true };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-protocol' };
  }
  if (isLoopbackHost(url.hostname) && policy.reservedPorts.includes(effectivePort(url))) {
    return { ok: false, reason: 'reserved-port' };
  }
  const key = originKey(rawUrl);
  const allowed = new Set(policy.allowedOrigins.map(originKey).filter((k) => k !== null));
  if (key !== null && allowed.has(key)) return { ok: true };
  if (!policy.publicWeb) return { ok: false, reason: 'origin-not-allowed' };
  const publicUrl = evaluatePublicUrl(rawUrl);
  if (!publicUrl.ok) {
    return publicUrl.reason === 'insecure-public-url' || publicUrl.reason === 'embedded-credentials'
      ? { ok: false, reason: publicUrl.reason }
      : { ok: false, reason: 'origin-not-allowed' };
  }
  if (policy.publicWeb === 'disabled') return { ok: false, reason: 'public-web-disabled' };
  const approved = new Set(policy.publicWeb.approvedOrigins.map(originKey));
  return approved.has(key) ? { ok: true } : { ok: false, reason: 'public-origin-not-approved' };
}

export function describeNavigationDenial(
  decision: Exclude<NavigationDecision, { ok: true }>,
  url: string
): string {
  switch (decision.reason) {
    case 'invalid-url':
      return `"${url}" is not a valid URL.`;
    case 'unsupported-protocol':
      return `Only http and https pages can be opened by agents (${url}).`;
    case 'reserved-port':
      return `${url} belongs to Chorus itself and cannot be opened by agents.`;
    case 'origin-not-allowed':
      return `${url} is outside this task's app. Agents can only open the task's dev-server origins or origins the user allowed.`;
    case 'insecure-public-url':
    case 'embedded-credentials':
      return describePublicUrlDenial(decision.reason, url);
    case 'public-web-disabled':
      return `${url} is a public website, and "Conductor can open public websites" is turned off in settings.`;
    case 'public-origin-not-approved':
      return `${url} is a public website the user has not approved for this browser. Open it with show_app so they can confirm it.`;
  }
}

/**
 * Sliding-window limiter keyed by an arbitrary string (browser id + action class).
 * The clock is injected so tests are deterministic.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Records a hit and returns true when it is within the limit. */
  tryAcquire(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forget(prefix: string): void {
    for (const key of [...this.hits.keys()]) if (key.startsWith(prefix)) this.hits.delete(key);
  }
}
