import { normalizeBrowserUrl } from '@core/primitives/browser/api';
import {
  classifyHost,
  describePublicUrlDenial,
  evaluatePublicUrl,
  originKey,
} from '@core/primitives/browser/api/control-policy';

/** What decides whether a task conductor may load a URL in one of the task's browser tabs. */
export type BrowserUrlContext = {
  /** Who started the turn: the developer's message, or a chat event. */
  readonly trigger: 'developer' | 'event';
  /** The developer's own message that started this turn; null on an event turn. */
  readonly developerWords: string | null;
  /** The origins of the task's running dev servers. */
  readonly devServerOrigins: readonly string[];
  /** The "Conductor can open public websites" setting. */
  readonly publicWebEnabled: boolean;
};

export type BrowserUrlDecision = { ok: true; url: string } | { ok: false; reason: string };

/** The page a browser opened with no address shows. */
const BLANK = 'about:blank';

/** Whether the developer's own words name this address: its host, with its port when it has one. */
function named(url: URL, words: string | null): boolean {
  if (!words) return false;
  const said = words.toLowerCase();
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const bare = host.replace(/^www\./, '');
  if (url.port) return said.includes(`${host}:${url.port}`) || said.includes(`${bare}:${url.port}`);
  return said.includes(host) || said.includes(bare);
}

/**
 * Whether a task conductor may load `rawUrl` in one of the task's browser tabs, and the address
 * to load. The tabs are the developer's own browser (their profile, their sign-ins), and the main
 * process does not police a page loaded the way the address bar loads it, so the conductor's
 * reach is fenced here, on the rules main applies to model-driven browsing
 * (`primitives/browser/api/control-policy.ts`):
 *
 * - The task's dev servers: always, on any turn the tool may run in.
 * - Other addresses on this computer: only when the developer asks, naming the address in the
 *   message that started the turn. Maestro's own servers listen on loopback too, and only main
 *   knows their ports, so the conductor never picks a loopback address itself.
 * - Private and internal hosts (a LAN, cloud metadata): never.
 * - Public websites: https only, no credentials in the address, with the setting on, and only
 *   on a turn the developer started whose message names the site. Never on an event turn: agent
 *   output must not be able to send the developer's browser somewhere.
 */
export function decideBrowserUrl(rawUrl: string, context: BrowserUrlContext): BrowserUrlDecision {
  const normalized = normalizeBrowserUrl(rawUrl, { allowSearchQueries: false });
  if (!normalized.ok) return { ok: false, reason: `"${rawUrl}" is not a web address.` };
  if (normalized.url === BLANK) return { ok: true, url: BLANK };
  let url: URL;
  try {
    url = new URL(normalized.url);
  } catch {
    return { ok: false, reason: `"${rawUrl}" is not a web address.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Only http and https pages can be opened (${rawUrl}).` };
  }
  const key = originKey(url.href);
  const devServers = new Set(context.devServerOrigins.map(originKey).filter(Boolean));
  if (key !== null && devServers.has(key)) return { ok: true, url: url.href };

  const kind = classifyHost(url.hostname);
  if (kind === 'private') {
    return {
      ok: false,
      reason: `${url.host} is a private or internal address; the conductor does not open those.`,
    };
  }
  const asked = context.trigger === 'developer' && named(url, context.developerWords);
  if (kind === 'loopback') {
    return asked
      ? { ok: true, url: url.href }
      : {
          ok: false,
          reason: `${url.host} is not one of this task's dev servers. Other addresses on this computer open only when the developer asks for them by address.`,
        };
  }
  const publicUrl = evaluatePublicUrl(url.href);
  if (!publicUrl.ok) {
    return { ok: false, reason: describePublicUrlDenial(publicUrl.reason, url.href) };
  }
  if (context.trigger === 'event') {
    return {
      ok: false,
      reason: `Not opening ${url.href}: public websites open only when the developer asks, never on what an agent said. Offer it to them instead.`,
    };
  }
  if (!context.publicWebEnabled) {
    return {
      ok: false,
      reason: `Not opening ${url.href}: public websites are turned off. The developer can turn on "Conductor can open public websites" in Settings, Browser. Do not retry until they have.`,
    };
  }
  if (!asked) {
    return {
      ok: false,
      reason: `Not opening ${url.href}: a public website opens only when the developer's own message names it (${url.hostname}). Ask them.`,
    };
  }
  return { ok: true, url: url.href };
}
