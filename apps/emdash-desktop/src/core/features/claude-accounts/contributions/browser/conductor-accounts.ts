import type { ClaudeAccount } from '../../api/types';
import { isAccountSignedIn } from '../../browser/account-model';
import { claudeAccountContextLines, matchClaudeAccount } from '../../browser/conductor-accounts';
import { getClaudeAccountsStore } from './app-stores';

/**
 * The conductor's view of the connected Claude accounts: the context lines with each account's
 * 5-hour and weekly usage, and the account a name it passes to spawn_agent means.
 */

/**
 * Lines for the conductor's per-turn context; empty with a single account. Uses the usage the
 * store already holds and asks for newer figures in the background, so a turn never waits.
 */
export function getClaudeAccountContextLines(now: number): string[] {
  try {
    const store = getClaudeAccountsStore();
    if (store.hasMultipleAccounts) store.refreshUsageIfStale();
    return claudeAccountContextLines(store.state, store.usage, now);
  } catch {
    // The store is not up (early startup, or a test without app stores): say nothing.
    return [];
  }
}

export type ClaudeAccountChoice =
  | { ok: true; account: ClaudeAccount }
  | { ok: false; message: string };

/** The signed-in account a reference from the conductor means, or why none can be used. */
export function resolveClaudeAccountChoice(reference: string): ClaudeAccountChoice {
  const store = getClaudeAccountsStore();
  const known = store.accounts.map((account) => account.label).join(', ');
  const account = matchClaudeAccount(store.state, reference);
  if (!account) {
    return {
      ok: false,
      message: `No Claude account matches "${reference}". Accounts: ${known || 'none'}.`,
    };
  }
  if (!isAccountSignedIn(account, store.usage.get(account.id))) {
    return {
      ok: false,
      message: `The Claude account "${account.label}" is not signed in. The developer signs in under Settings, Claude accounts. Accounts: ${known}.`,
    };
  }
  return { ok: true, account };
}
