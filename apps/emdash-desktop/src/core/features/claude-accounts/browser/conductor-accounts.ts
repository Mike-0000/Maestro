import type {
  ClaudeAccount,
  ClaudeAccountsState,
  ClaudeAccountUsage,
  ClaudeUsageWindow,
} from '../api/types';
import { isAccountSignedIn } from './account-model';
import {
  formatResetsIn,
  formatUpdatedAgo,
  formatUsagePercent,
  usagePlanLabel,
} from './usage-model';

/**
 * What the conductor is told about the connected Claude accounts, and how a name it gives back
 * is matched to one. Pure: the store supplies the state and the usage.
 */

type UsageLookup = { get(accountId: string): ClaudeAccountUsage | undefined };

function windowPhrase(name: string, window: ClaudeUsageWindow | null, now: number): string {
  // The service reports no window until the first request of a new one.
  if (!window) return `${name} 0% used (no window open)`;
  const resets = formatResetsIn(window.resetsAt, now);
  return `${name} ${formatUsagePercent(window.usedPercent)} used${resets ? `, ${resets}` : ''}`;
}

function usagePhrase(usage: ClaudeAccountUsage | undefined, now: number): string {
  const snapshot = usage?.snapshot;
  if (!snapshot) return 'usage unknown';
  const parts = [
    windowPhrase('5-hour', snapshot.fiveHour, now),
    windowPhrase('weekly', snapshot.sevenDay, now),
  ];
  if (usage.status === 'stale') {
    const fetchedAt = Date.parse(snapshot.fetchedAt);
    const age = Number.isNaN(fetchedAt) ? null : formatUpdatedAgo(fetchedAt, now);
    parts.push(`figures are old${age ? ` (${age.toLowerCase()})` : ''}`);
  }
  return parts.join('; ');
}

/**
 * The context lines listing each account with its 5-hour and weekly usage. Empty with a single
 * account: there is nothing to choose between.
 */
export function claudeAccountContextLines(
  state: ClaudeAccountsState | null,
  usage: UsageLookup,
  now: number
): string[] {
  if (!state || state.accounts.length < 2) return [];
  const lines = [
    'Claude accounts (subscriptions a new claude agent can run on; spawn_agent takes one as claude_account, and uses the default when it is omitted):',
  ];
  for (const account of state.accounts) {
    const accountUsage = usage.get(account.id);
    const plan = usagePlanLabel(accountUsage, account);
    const tags = [
      account.id === state.defaultAccountId ? 'default' : null,
      plan ? `${plan} plan` : null,
    ].filter((tag): tag is string => tag !== null);
    const detail = isAccountSignedIn(account, accountUsage)
      ? usagePhrase(accountUsage, now)
      : 'not signed in, cannot be used';
    lines.push(`- ${account.label}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}: ${detail}`);
  }
  return lines;
}

/**
 * The accounts as a chat's conductor reads them: each with its usage and sign-in state, the
 * default for new agents, and the one the chat's own agent runs on (`currentAccountId`, null when
 * the chat's agent is not Claude Code and so runs on none).
 */
export function claudeAccountListLines(
  state: ClaudeAccountsState | null,
  usage: UsageLookup,
  now: number,
  currentAccountId: string | null
): string[] {
  if (!state || state.accounts.length === 0) return ['Claude accounts are not available.'];
  const lines = state.accounts.map((account) => {
    const accountUsage = usage.get(account.id);
    const plan = usagePlanLabel(accountUsage, account);
    const tags = [
      account.id === currentAccountId ? "this chat's agent runs on it" : null,
      account.id === state.defaultAccountId ? 'default for new agents' : null,
      plan ? `${plan} plan` : null,
    ].filter((tag): tag is string => tag !== null);
    const detail = isAccountSignedIn(account, accountUsage)
      ? usagePhrase(accountUsage, now)
      : 'not signed in, cannot be used';
    return `- ${account.label}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}: ${detail}`;
  });
  return [
    'Claude accounts (subscriptions a Claude Code agent can run on):',
    ...lines,
    ...(currentAccountId === null
      ? ["This chat's agent is not Claude Code, so it runs on none of them."]
      : []),
  ];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The account a loose reference means: its label in any case or punctuation, "default", or a
 * label the reference contains or is contained in when exactly one account fits ("the work
 * account" for "Work"). Null when none or several fit.
 */
export function matchClaudeAccount(
  state: ClaudeAccountsState | null,
  reference: string
): ClaudeAccount | null {
  if (!state) return null;
  const wanted = normalize(reference).replace(/\b(the|claude|account|subscription|sub)\b/g, ' ');
  const key = wanted.replace(/\s+/g, ' ').trim();
  if (!key) return null;
  if (key === 'default') {
    return state.accounts.find((account) => account.id === state.defaultAccountId) ?? null;
  }
  const exact = state.accounts.filter((account) => normalize(account.label) === key);
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) return null;
  const loose = state.accounts.filter((account) => {
    const label = normalize(account.label);
    return label.length > 0 && (label.includes(key) || key.includes(label));
  });
  return loose.length === 1 ? (loose[0] ?? null) : null;
}
