import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { useCallback } from 'react';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { ClaudeAccount } from '../api/types';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { CLAUDE_LOGIN_METHOD_ID, CLAUDE_PROVIDER_ID } from './account-model';

/**
 * Opens the sign-in terminal for one Claude account. Resolves once the terminal is closed and
 * the account's sign-in state and usage have been asked for again.
 */
export function useClaudeAccountSignIn(): (
  account: Pick<ClaudeAccount, 'id' | 'label'>
) => Promise<void> {
  const openSignIn = useOpenModal('agentSignInModal');
  return useCallback(
    async (account) => {
      const outcome = await openSignIn({
        providerId: CLAUDE_PROVIDER_ID,
        methodId: CLAUDE_LOGIN_METHOD_ID,
        providerName: 'Claude Code',
        host: LOCAL_HOST_REF,
        claudeAccount: { id: account.id, label: account.label },
      });
      const store = getClaudeAccountsStore();
      // Closed by hand: the sign-in may still have gone through, so ask Claude Code.
      if (!outcome.success) await store.refreshIdentity(account.id).catch(() => undefined);
      void store.refreshUsage({ force: true });
    },
    [openSignIn]
  );
}
