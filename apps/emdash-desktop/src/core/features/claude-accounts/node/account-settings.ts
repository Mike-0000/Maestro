import { isEmdashHookText } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { CLAUDE_AUTH_OVERRIDE_ENV } from '../api/node/launch';

/**
 * How `settings.json` differs between the primary setup and an extra account's copy.
 *
 * The account's copy never carries the ways the primary file can sign a session in: an
 * account session reading them would run as the primary sign-in, and a token would sit in the
 * account folder. It does keep hooks the app itself installed into it: the hook installer
 * writes them into whichever configuration directory a session uses and remembers having done
 * so, so losing them on a sync would lose them for good.
 */

/** Top-level settings that choose or force how Claude Code signs in. */
const SIGN_IN_SETTINGS = ['apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID'] as const;
const SIGN_IN_ENV = new Set(CLAUDE_AUTH_OVERRIDE_ENV.map((name) => name.toLowerCase()));

type Json = Record<string, unknown>;

/**
 * The account's `settings.json` for the given primary file: the primary file without its
 * sign-in settings, with the app's own hook entries taken from the account's current copy.
 * When neither changes anything, the result is the primary text byte for byte. Null means the
 * account has no file. A primary file that is not a JSON object is passed through as it is.
 */
export function accountSettingsFrom(
  primaryText: string | null,
  accountText: string | null,
  options: { keepSignIn?: boolean } = {}
): string | null {
  const primary = primaryText === null ? {} : parseObject(primaryText);
  if (!primary) return primaryText;
  const base = options.keepSignIn ? primary : withoutSignIn(primary);
  const merged = withAccountHooks(base, parseObject(accountText ?? '')?.hooks);
  if (canonical(merged) === canonical(primary)) return primaryText;
  return serialize(merged);
}

/**
 * The primary `settings.json` after an edit made in an account's copy: the account's file,
 * with the primary file's own sign-in settings put back (and any the account's copy carries
 * dropped, so a sign-in never travels from an account into the shared setup). When that is
 * what the primary file already says, the result is its text byte for byte. Undefined when
 * either side is not a JSON object, so nothing can be merged safely.
 */
export function primarySettingsFrom(
  accountText: string,
  primaryText: string | null
): string | null | undefined {
  const account = parseObject(accountText);
  const primary = primaryText === null ? {} : parseObject(primaryText);
  if (!account || !primary) return undefined;

  const next = withoutSignIn(account);
  for (const key of SIGN_IN_SETTINGS) if (key in primary) next[key] = primary[key];
  const signInEnv = Object.entries(asRecord(primary.env) ?? {}).filter(([name]) =>
    SIGN_IN_ENV.has(name.toLowerCase())
  );
  if (signInEnv.length > 0) {
    next.env = { ...asRecord(next.env), ...Object.fromEntries(signInEnv) };
  }
  if (canonical(next) === canonical(primary)) return primaryText;
  return serialize(next);
}

/** Whether two settings files say the same thing, whatever their formatting or key order. */
export function sameSettings(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftObject = parseObject(left);
  const rightObject = parseObject(right);
  return leftObject !== null && rightObject !== null
    ? canonical(leftObject) === canonical(rightObject)
    : false;
}

function withoutSignIn(settings: Json): Json {
  const next = { ...settings };
  for (const key of SIGN_IN_SETTINGS) delete next[key];
  const env = asRecord(next.env);
  if (env) {
    const kept = Object.entries(env).filter(([name]) => !SIGN_IN_ENV.has(name.toLowerCase()));
    if (kept.length === Object.keys(env).length) return next;
    if (kept.length === 0) delete next.env;
    else next.env = Object.fromEntries(kept);
  }
  return next;
}

/**
 * For each hook event, the app's entries in the account's copy replace the app's entries in
 * the settings; everything else stays.
 */
function withAccountHooks(settings: Json, accountHooks: unknown): Json {
  const fromAccount = asRecord(accountHooks);
  if (!fromAccount) return settings;
  const hooks: Json = { ...asRecord(settings.hooks) };
  let changed = false;
  for (const [event, entries] of Object.entries(fromAccount)) {
    if (!Array.isArray(entries)) continue;
    const managed = entries.filter(isManagedHook);
    if (managed.length === 0) continue;
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (sameEntries(existing.filter(isManagedHook), managed)) continue;
    hooks[event] = [...existing.filter((entry) => !isManagedHook(entry)), ...managed];
    changed = true;
  }
  return changed ? { ...settings, hooks } : settings;
}

function isManagedHook(entry: unknown): boolean {
  return isEmdashHookText(JSON.stringify(entry));
}

function sameEntries(left: unknown[], right: unknown[]): boolean {
  const sorted = (entries: unknown[]) => entries.map((entry) => canonical(entry)).sort();
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function serialize(settings: Json): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** JSON with object keys sorted at every level, for comparing meaning rather than text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    const record = asRecord(inner);
    if (!record) return inner;
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
  });
}

export function parseObject(text: string): Json | null {
  try {
    return asRecord(JSON.parse(text)) ?? null;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}
