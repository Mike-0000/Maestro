/** What `claude auth status --json` says about one configuration directory. */
export type ClaudeIdentity = {
  loggedIn: boolean;
  email?: string;
  plan?: string;
};

/**
 * Reads the CLI's status report. The CLI exits 1 when signed out and still prints the report,
 * so the exit code only decides the answer when the report does not say. Returns null when
 * the output is not a report at all.
 */
export function parseClaudeAuthStatus(
  stdout: string,
  exitCode: number | null
): ClaudeIdentity | null {
  const status = parseObject(stdout);
  if (!status) return null;
  const loggedIn = typeof status.loggedIn === 'boolean' ? status.loggedIn : exitCode === 0;
  if (!loggedIn) return { loggedIn: false };
  const oauthAccount = asRecord(status.oauthAccount);
  const email = firstString(
    status.email,
    status.account,
    status.accountEmail,
    oauthAccount?.emailAddress,
    oauthAccount?.email
  );
  const plan = firstString(status.subscriptionType, status.plan, oauthAccount?.subscriptionType);
  return { loggedIn: true, ...(email && { email }), ...(plan && { plan }) };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
