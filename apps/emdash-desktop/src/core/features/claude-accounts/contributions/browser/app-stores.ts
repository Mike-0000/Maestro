import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { ClaudeAccountsStore } from '../../browser/claude-accounts-store';

const claudeAccountsStoreToken = scopedStoreToken<ClaudeAccountsStore>('claudeAccounts.store');

export const claudeAccountsAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: claudeAccountsStoreToken,
    create: () => new ClaudeAccountsStore(),
    activate: (store) => store.start(),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped ClaudeAccountsStore. */
export function getClaudeAccountsStore(): ClaudeAccountsStore {
  return getAppStores().get(claudeAccountsStoreToken);
}
