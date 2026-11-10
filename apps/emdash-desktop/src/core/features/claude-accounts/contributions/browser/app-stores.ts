import { toast } from '@emdash/ui/react/primitives';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { ClaudeAccountsStore } from '../../browser/claude-accounts-store';
import type { LimitNotice, LimitNoticeEvent } from '../../browser/limit-notices';

const claudeAccountsStoreToken = scopedStoreToken<ClaudeAccountsStore>('claudeAccounts.store');

function showLimitNotice(notice: LimitNotice): void {
  const options = {
    id: notice.id,
    ...(notice.description ? { description: notice.description } : {}),
  };
  if (notice.tone === 'error') toast.error(notice.title, options);
  else if (notice.tone === 'warning') toast.warning(notice.title, options);
  else toast(notice.title, options);
}

/** The title of a conversation whose task is loaded in this window; null otherwise. */
function loadedConversationTitle(event: LimitNoticeEvent): string | null {
  const conversation = conversationRegistry
    .get(event.taskId)
    ?.conversations.get(event.conversationId)?.data;
  if (!conversation?.title) return null;
  return formatConversationTitleForDisplay(conversation.providerId, conversation.title);
}

export const claudeAccountsAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: claudeAccountsStoreToken,
    create: () =>
      new ClaudeAccountsStore({
        notify: showLimitNotice,
        conversationTitle: loadedConversationTitle,
      }),
    activate: (store) => store.start(),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped ClaudeAccountsStore. */
export function getClaudeAccountsStore(): ClaudeAccountsStore {
  return getAppStores().get(claudeAccountsStoreToken);
}
