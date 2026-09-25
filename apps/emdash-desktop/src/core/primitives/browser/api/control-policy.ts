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

export type NavigationDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid-url' | 'unsupported-protocol' | 'origin-not-allowed' | 'reserved-port';
    };

export type NavigationPolicy = {
  /** Origins the model may load, e.g. the task's dev-server origins plus user-approved extras. */
  allowedOrigins: readonly string[];
  /** Loopback ports that belong to Chorus itself (hook, credential, control servers). */
  reservedPorts: readonly number[];
};

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
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
  return key !== null && allowed.has(key)
    ? { ok: true }
    : { ok: false, reason: 'origin-not-allowed' };
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
