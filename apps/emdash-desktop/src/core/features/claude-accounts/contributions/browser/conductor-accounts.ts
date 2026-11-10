import type { MoveClaudeAccountError } from '@core/features/conversations/api/claude-account-move';
import type { ClaudeAccount } from '../../api/types';
import { CLAUDE_PROVIDER_ID, isAccountSignedIn } from '../../browser/account-model';
import {
  claudeAccountContextLines,
  claudeAccountListLines,
  matchClaudeAccount,
} from '../../browser/conductor-accounts';
import {
  conversationAccountId,
  moveClaudeAccountErrorCopy,
} from '../../browser/conversation-move-model';
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

type ChatConversation = { providerId: string; claudeAccountId?: string };

/**
 * The account a conversation's agent runs on, or null when it runs on none (another agent) or
 * the accounts are not loaded.
 */
export function getConversationClaudeAccount(conversation: ChatConversation): ClaudeAccount | null {
  if (conversation.providerId !== CLAUDE_PROVIDER_ID) return null;
  const store = getClaudeAccountsStore();
  const state = store.state;
  if (!state) return null;
  return store.account(conversationAccountId(state, conversation)) ?? null;
}

/**
 * The accounts with their usage, for a chat's conductor, marking the one its agent runs on. Uses
 * the usage the store already holds and asks for newer figures in the background.
 */
export function describeClaudeAccountsForChat(conversation: ChatConversation, now: number): string {
  const store = getClaudeAccountsStore();
  store.refreshUsageIfStale();
  const current = getConversationClaudeAccount(conversation);
  return claudeAccountListLines(store.state, store.usage, now, current?.id ?? null).join('\n');
}

/** Why a move to another account failed, in a sentence or two, as the move menu words it. */
export function describeClaudeAccountMoveError(
  error: MoveClaudeAccountError,
  accounts: { target: string; previous: string }
): string {
  const copy = moveClaudeAccountErrorCopy(error, accounts);
  return copy.description ? `${copy.title}. ${copy.description}` : `${copy.title}.`;
}
