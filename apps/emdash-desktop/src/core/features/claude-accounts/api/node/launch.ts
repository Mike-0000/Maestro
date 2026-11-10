/**
 * How another slice launches Claude Code under an extra account. The primary account has no
 * launch: its sessions start exactly as they would without accounts.
 */

/** The provider these accounts belong to. */
export const CLAUDE_ACCOUNTS_PROVIDER_ID = 'claude';

/** Names Claude Code reads its configuration directory from. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Credentials Claude Code prefers over a subscription sign-in. A session under an extra account
 * must not see them, or it would run on that key or token instead of the chosen account.
 */
export const CLAUDE_AUTH_OVERRIDE_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type ClaudeAccountLaunch = {
  accountId: string;
  /** The account's configuration directory on this computer. */
  configDir: string;
};

export type ClaudeAccountLaunchResolver = {
  /**
   * The extra account a conversation runs under, or null for the primary account. A
   * conversation with no recorded account was created before accounts existed, on the primary
   * sign-in, and stays there. A recorded account that was removed resolves to the current
   * default account. Cheap: no file access.
   */
  resolve(accountId: string | undefined): Promise<ClaudeAccountLaunch | null>;
  /** Brings the account's folder up to date. Idempotent; call right before a process starts. */
  prepare(launch: ClaudeAccountLaunch): Promise<void>;
};

export type ClaudeAccountSessionEnv = {
  /** The session's own variables, with the account's configuration directory set. */
  env: Record<string, string>;
  /** Variables to remove from the assembled process environment, wherever they came from. */
  unsetEnv: string[];
};

/**
 * Points a session's variables at an extra account: sets the configuration directory and drops
 * the credentials that would outrank the account's sign-in. `unsetEnv` covers the copies the
 * session would otherwise inherit from the user's shell. Names match case-insensitively, as
 * Windows treats them.
 */
export function applyClaudeAccountEnv(
  sessionEnv: Readonly<Record<string, string>>,
  launch: ClaudeAccountLaunch
): ClaudeAccountSessionEnv {
  const dropped = new Set(
    [...CLAUDE_AUTH_OVERRIDE_ENV, CLAUDE_CONFIG_DIR_ENV].map((name) => name.toLowerCase())
  );
  const env = Object.fromEntries(
    Object.entries(sessionEnv).filter(([name]) => !dropped.has(name.toLowerCase()))
  );
  env[CLAUDE_CONFIG_DIR_ENV] = launch.configDir;
  return { env, unsetEnv: [...CLAUDE_AUTH_OVERRIDE_ENV] };
}
