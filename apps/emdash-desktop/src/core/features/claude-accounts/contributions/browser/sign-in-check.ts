import { claudeAccountsErrorMessage } from '../../browser/account-model';
import { getClaudeAccountsStore } from './app-stores';

export type ClaudeSignInCheck =
  | { kind: 'signed-in'; email?: string }
  | { kind: 'not-signed-in' }
  /** Claude Code could not be asked; `message` says why in plain words. */
  | { kind: 'failed'; message: string };

/**
 * Asks Claude Code whether an account is signed in now, and records the answer. For the
 * sign-in dialog, once the sign-in command has exited.
 */
export async function checkClaudeAccountSignIn(accountId: string): Promise<ClaudeSignInCheck> {
  try {
    const result = await getClaudeAccountsStore().refreshIdentity(accountId);
    if (!result.success) {
      return { kind: 'failed', message: claudeAccountsErrorMessage(result.error) };
    }
    return result.data.loggedIn
      ? { kind: 'signed-in', email: result.data.email }
      : { kind: 'not-signed-in' };
  } catch {
    return { kind: 'failed', message: 'Something went wrong. Try again.' };
  }
}
