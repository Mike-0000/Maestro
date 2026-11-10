import { conversationAccountLabel, conversationSignInAccount } from '../../browser/account-model';
import { getClaudeAccountsStore } from './app-stores';

/**
 * The Claude account an existing conversation runs under, by name, or null when there is
 * nothing worth showing: another agent, or only one account. Reads the accounts store, so call
 * it from an observer component.
 */
export function getConversationClaudeAccountLabel(conversation: {
  providerId: string;
  claudeAccountId?: string;
}): string | null {
  return conversationAccountLabel(getClaudeAccountsStore().state, conversation);
}

/**
 * The extra Claude account to sign in to when this conversation asks for a sign-in, or
 * undefined when the normal provider sign-in is right (another agent, another machine, or the
 * primary account). Pass the result to the sign-in dialog as `claudeAccount`.
 */
export function getConversationSignInAccount(
  conversation: { providerId: string; claudeAccountId?: string },
  options: { remote: boolean }
): { id: string; label: string } | undefined {
  return conversationSignInAccount(
    () => getClaudeAccountsStore().state,
    conversation,
    options.remote
  );
}
