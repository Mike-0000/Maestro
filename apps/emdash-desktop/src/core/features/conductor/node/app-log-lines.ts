import { redactAll } from '@emdash/shared/logger';

/**
 * Turns a line of the main process log (`emdash.log`) into a record the remote log upload may send,
 * or null when the line is not one it sends.
 *
 * Sent: warnings and errors written by the main process and its workers (in a production build the
 * file holds nothing below warn), such as startup, project attachment, connection, auth, network and
 * update failures. Not sent: the periodic heartbeats, which are resource samples rather than
 * events, and the renderer's lines, which can quote what the developer typed.
 *
 * What a line carries is reduced before it leaves the computer: fields that hold output, prompts
 * or text (`chunk`, `data`, `prompt`, `content`, `command` and the like) and every field named like
 * a secret are dropped, strings are shortened, and what remains is redacted for secrets, tokens,
 * the upload key itself, emails, IP addresses and user names in paths.
 */

/** pino's numeric levels, for a line written with them. */
const LEVEL_NAMES: Record<number, string> = { 40: 'warn', 50: 'error', 60: 'fatal' };
const SENT_LEVELS = new Set(['warn', 'error', 'fatal']);

/** Messages that are periodic samples, not events. */
const SKIPPED_MESSAGE = /: heartbeat$/;

/**
 * Field names whose values are output, user text or file contents (dropped whole), or name a
 * secret. Matched against every key, nested ones included.
 */
const DROPPED_KEY =
  /^(?:chunk|data|text|prompt|prompts|content|contents|body|input|output|topOutput|transcript|stdout|stderr|args|argv|payload|command|cmd|env|headers?|cookies?|query|diff|patch|line|lines|messages)$|token|secret|password|passphrase|authorization|api[_-]?key|anon[_-]?key|credential|cookie/i;

const MAX_STRING = 1_000;
const MAX_STACK = 2_000;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

/** Supabase keys, which `redactAll` does not know. */
const SUPABASE_KEY = /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export type AppLogRecord = { record: Record<string, unknown>; recordedAt: string };

function clean(value: unknown, depth: number, key: string): unknown {
  if (typeof value === 'string') {
    const limit = key === 'stack' ? MAX_STACK : MAX_STRING;
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => clean(item, depth + 1, key));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (DROPPED_KEY.test(name)) continue;
      out[name] = clean(item, depth + 1, name);
    }
    return out;
  }
  return undefined;
}

function redactText(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return redactAll(text.replace(SUPABASE_KEY, '[REDACTED_SUPABASE_KEY]')).replace(
    BEARER,
    '$1 [REDACTED]'
  );
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactDeep(item, secrets)])
    );
  }
  return value;
}

/**
 * The record to send for one line of `emdash.log`, or null. `secrets` are values that must never
 * leave the computer even where no pattern knows them, such as the upload key.
 */
export function appLogRecord(line: string, secrets: readonly string[] = []): AppLogRecord | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;

  const level =
    typeof entry.level === 'number' ? LEVEL_NAMES[entry.level] : (entry.level as unknown);
  if (typeof level !== 'string' || !SENT_LEVELS.has(level)) return null;
  // The renderer's lines are not the main process's, and may quote what the developer typed.
  if (entry.source === 'renderer') return null;
  const at = entry.time ?? entry.timestamp;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const msg = typeof entry.msg === 'string' ? entry.msg : '';
  if (SKIPPED_MESSAGE.test(msg)) return null;

  const rest = clean(entry, 0, '') as Record<string, unknown>;
  delete rest.level;
  delete rest.time;
  delete rest.timestamp;
  delete rest.msg;
  const record = redactDeep({ level, msg: clean(msg, 0, 'msg'), ...rest }, secrets) as Record<
    string,
    unknown
  >;
  return { record, recordedAt: new Date(Date.parse(at)).toISOString() };
}
