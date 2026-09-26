import { redactSecrets } from '@emdash/shared/logger';

/**
 * An agent's final user-facing reply, prepared for the conductor: what the agent told the
 * developer when it finished a turn ("Started the dev server at http://localhost:5173 …").
 *
 * Only the final reply goes in — never reasoning, tool output, or the rest of the transcript. The
 * text is redacted (tokens, keys, credentials in URLs), stripped of terminal control sequences,
 * and bounded: a long reply keeps its head and tail, which is where agents put the summary and
 * the "next steps". Local app URLs are pulled out as structured data so the conductor can offer
 * to open them without parsing prose. The reply is untrusted data: consumers must never treat it
 * as instructions or as the developer's consent.
 */
export type CompletionReport = {
  /** The redacted, bounded reply. */
  readonly text: string;
  /** True when the middle of a long reply was dropped. */
  readonly truncated: boolean;
  /** Loopback URLs the reply mentions (dev servers), normalized, first mention first. */
  readonly appUrls: readonly string[];
};

export const COMPLETION_REPORT_MAX_CHARS = 4_000;
/** Longer inputs are cut before any regex runs, so a pathological reply stays cheap. */
const MAX_INPUT_CHARS = 200_000;
const TAIL_CHARS = 1_000;
const MAX_APP_URLS = 3;

const LOOPBACK_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)`;
const URL_TAIL = String.raw`(?:[/?#][^\s<>"'\`)\]]*)?`;
const LOOPBACK_URL = new RegExp(
  String.raw`\bhttps?:\/\/${LOOPBACK_HOST}(?::\d{2,5})?${URL_TAIL}` +
    // Bare "localhost:3000" without a scheme.
    String.raw`|(?<![\w/.@-])${LOOPBACK_HOST}:\d{2,5}${URL_TAIL}`,
  'gi'
);

/** Builds the conductor-facing report, or null when the reply is missing or empty. */
export function buildCompletionReport(
  message: string | null | undefined,
  maxChars = COMPLETION_REPORT_MAX_CHARS
): CompletionReport | null {
  if (typeof message !== 'string') return null;
  const clean = redactReply(message.slice(0, MAX_INPUT_CHARS));
  if (!clean) return null;
  const appUrls = extractAppUrls(clean);
  if (clean.length <= maxChars) return { text: clean, truncated: false, appUrls };
  const tail = Math.min(TAIL_CHARS, Math.floor(maxChars / 4));
  const head = maxChars - tail;
  const omitted = clean.length - head - tail;
  return {
    text: `${clean.slice(0, head).trimEnd()}\n\n[… ${omitted.toLocaleString('en-US')} characters omitted …]\n\n${clean.slice(-tail).trimStart()}`,
    truncated: true,
    appUrls,
  };
}

/** Removes control sequences and secrets and trims blank space. */
export function redactReply(text: string): string {
  const withoutControls = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return redactSecrets(withoutControls)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/?#@]+:[^\s@/?#]+@/gi, '$1[REDACTED_CREDENTIALS]@')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Loopback app URLs in a reply ("http://localhost:5173/admin"), deduplicated. */
export function extractAppUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(LOOPBACK_URL)) {
    const raw = match[0].replace(/[.,;:!?]+$/, '');
    const url = normalizeAppUrl(/^https?:/i.test(raw) ? raw : `http://${raw}`);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length === MAX_APP_URLS) break;
  }
  return urls;
}

/** True for http(s) URLs on this machine's loopback interface — where dev servers run. */
export function isLocalAppUrl(url: string): boolean {
  return normalizeAppUrl(url) !== null;
}

/** "localhost port 5173", or "localhost port 5173 slash admin", for speech. */
export function spokenAppUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host =
    parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' ? 'localhost' : parsed.hostname;
  const port = parsed.port ? ` port ${parsed.port}` : '';
  const path = parsed.pathname.split('/').filter(Boolean).slice(0, 3);
  return `${host}${port}${path.map((segment) => ` slash ${decodeSegment(segment)}`).join('')}`;
}

function normalizeAppUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '[::]' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) return null;
  // A server bound to every interface is reached through localhost.
  if (host === '0.0.0.0' || host === '[::]') parsed.hostname = 'localhost';
  return parsed.toString();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The shape of an ACP transcript turn this module reads (kept structural to stay portable). */
export type ReplyTurnItem =
  | { readonly kind: 'message'; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly kind: string; readonly role?: unknown; readonly text?: unknown };

/**
 * The final user-facing reply of a chat turn: the assistant messages after the turn's last tool
 * call (thinking is skipped, never included). Falls back to the last assistant message.
 */
export function finalAssistantReply(items: readonly ReplyTurnItem[]): string | null {
  const trailing: string[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === 'thinking') continue;
    if (item.kind !== 'message' || item.role !== 'assistant') break;
    if (typeof item.text === 'string') trailing.unshift(item.text);
  }
  const reply = trailing.join('\n\n').trim();
  if (reply) return reply;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === 'message' && item.role === 'assistant' && typeof item.text === 'string') {
      if (item.text.trim()) return item.text.trim();
    }
  }
  return null;
}
