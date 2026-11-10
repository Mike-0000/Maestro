import type { MoveClaudeAccountError } from '@core/features/conversations/api/claude-account-move';
import {
  PRIMARY_CLAUDE_ACCOUNT_ID,
  type ClaudeAccountsState,
  type ClaudeAccountUsage,
} from '../api/types';
import { CLAUDE_PROVIDER_ID } from './account-model';
import { formatUsagePercent } from './usage-model';

type ConversationAccountInput = { providerId: string; claudeAccountId?: string };

/**
 * The id of the account a conversation runs under: the one recorded, `primary` when none is
 * (it predates accounts), or the default when the recorded account was removed.
 */
export function conversationAccountId(
  state: ClaudeAccountsState,
  conversation: ConversationAccountInput
): string {
  const recorded = conversation.claudeAccountId ?? PRIMARY_CLAUDE_ACCOUNT_ID;
  return state.accounts.some((account) => account.id === recorded)
    ? recorded
    : state.defaultAccountId;
}

/**
 * Whether a conversation offers "Continue on another account": Claude Code on this computer,
 * with more than one account to choose from.
 */
export function canMoveConversationAccount(
  state: ClaudeAccountsState | null,
  conversation: ConversationAccountInput,
  options: { remote: boolean }
): boolean {
  if (!state || state.accounts.length < 2) return false;
  return conversation.providerId === CLAUDE_PROVIDER_ID && !options.remote;
}

/** `weekly 46% · 5-hour 12%`, or null when no usage is known for the account. */
export function accountUsageSummary(usage: ClaudeAccountUsage | undefined): string | null {
  const snapshot = usage?.snapshot;
  if (!snapshot) return null;
  const parts = [
    snapshot.sevenDay ? `weekly ${formatUsagePercent(snapshot.sevenDay.usedPercent)}` : null,
    snapshot.fiveHour ? `5-hour ${formatUsagePercent(snapshot.fiveHour.usedPercent)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** What a failed move reports: a headline, and a sentence on why when there is one. */
export function moveClaudeAccountErrorCopy(
  error: MoveClaudeAccountError,
  accounts: { target: string; previous: string }
): { title: string; description?: string } {
  const title = `Couldn't continue on ${accounts.target}`;
  switch (error.type) {
    case 'conversation-not-found':
      return { title, description: 'This conversation no longer exists.' };
    case 'not-claude-conversation':
      return { title, description: 'Only Claude Code conversations run on an account.' };
    case 'not-local':
      return { title, description: 'Accounts only apply to conversations on this computer.' };
    case 'unsupported':
      return { title, description: "This conversation can't move to another account." };
    case 'session-unavailable':
      return {
        title,
        description: "Its session can't be reached right now. Open its task and try again.",
      };
    case 'account-not-found':
      return { title, description: 'That account no longer exists.' };
    case 'account-signed-out':
      return {
        title,
        description: `${accounts.target} isn't signed in. Sign in to it in Settings, then try again.`,
      };
    case 'same-account':
      return { title, description: `The conversation already runs on ${accounts.target}.` };
    case 'config-write-failed':
      return { title, description: "The change couldn't be saved. Nothing was changed." };
    case 'restart-failed':
      return error.restored
        ? {
            title: `Couldn't restart on ${accounts.target}. The conversation is back on ${accounts.previous}.`,
          }
        : {
            title: `Couldn't restart on ${accounts.target}`,
            description: "The conversation didn't come back. Try starting it again.",
          };
  }
}
