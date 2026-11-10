import { toast } from '@emdash/ui/react/primitives';
import { openModal } from '@core/manifests/browser/modal-api';
import { claudeAccountsErrorMessage, nextDefaultAccountId } from '../../browser/account-model';
import { getClaudeAccountsStore } from './app-stores';

/** Opens the usage pane as a dialog, from wherever the user is. */
export function showClaudeUsage(): void {
  void openModal('claudeUsageModal');
}

/** Whether "Switch Claude Account" has anything to switch between. */
export function canSwitchClaudeAccount(): boolean {
  return getClaudeAccountsStore().hasMultipleAccounts;
}

/**
 * Makes `accountId` the account new agents use; without one, moves to the next signed-in
 * account. Says what happened in a toast, since nothing else on screen may show it.
 */
export async function switchClaudeAccount(accountId?: string): Promise<void> {
  const store = getClaudeAccountsStore();
  const state = store.state;
  if (!state) return;
  const targetId = accountId ?? nextDefaultAccountId(state, (account) => store.isSignedIn(account));
  const target = targetId ? store.account(targetId) : undefined;
  if (!target) {
    toast('No other signed-in Claude account', {
      description: 'Add or sign in to one in Settings > Claude accounts.',
    });
    return;
  }
  if (target.id === state.defaultAccountId) {
    toast(`New agents already use ${target.label}`);
    return;
  }
  try {
    const result = await store.setDefault(target.id);
    if (result.success) {
      toast(`New agents now use ${target.label}`, { description: target.email });
    } else {
      toast.error("Couldn't switch account", {
        description: claudeAccountsErrorMessage(result.error),
      });
    }
  } catch {
    toast.error("Couldn't switch account");
  }
}
