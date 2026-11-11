import { DropdownMenu, toast } from '@emdash/ui/react/primitives';
import { ArrowLeftRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { accountOptionLabel } from '../../browser/account-model';
import {
  accountUsageSummary,
  canMoveConversationAccount,
  conversationAccountId,
  moveClaudeAccountErrorCopy,
} from '../../browser/conversation-move-model';
import { getClaudeAccountsStore } from './app-stores';

type MoveMenuConversation = {
  id: string;
  providerId: string;
  claudeAccountId?: string;
};

/** Moves a conversation to another account and reports how it went in a toast. */
async function moveConversation(
  conversationId: string,
  target: { id: string; label: string },
  previousLabel: string
): Promise<void> {
  try {
    const client = await getConversationsClient();
    const result = await client.moveClaudeAccount({ conversationId, accountId: target.id });
    if (result.success) {
      toast(`Continued on ${target.label}`);
      return;
    }
    const copy = moveClaudeAccountErrorCopy(result.error, {
      target: target.label,
      previous: previousLabel,
    });
    toast.error(copy.title, copy.description ? { description: copy.description } : undefined);
  } catch {
    toast.error(`Couldn't continue on ${target.label}`, {
      description: 'Something went wrong. Try again.',
    });
  }
}

/**
 * "Continue on another account" for a conversation's menu: a submenu of the Claude accounts with
 * their usage, the current one checked. Renders nothing unless the conversation is Claude Code on
 * this computer and there is more than one account. Place it inside a menu's content; it brings
 * its own leading separator.
 */
export const ClaudeAccountMoveSubmenu = observer(function ClaudeAccountMoveSubmenu({
  conversation,
  remote,
  working,
}: {
  conversation: MoveMenuConversation;
  /** True when the conversation runs on another machine, which keeps its own sign-in. */
  remote: boolean;
  /** True while the agent is in a turn; moving stops it, so ask first. */
  working: boolean;
}) {
  const store = getClaudeAccountsStore();
  const openConfirm = useOpenModal('confirmActionModal');
  const state = store.state;
  const visible = canMoveConversationAccount(state, conversation, { remote });

  // The usage figures next to each account should not be hours old.
  useEffect(() => {
    if (visible) store.refreshUsageIfStale();
  }, [visible, store]);

  if (!state || !visible) return null;
  const currentId = conversationAccountId(state, conversation);
  const previousLabel = store.account(currentId)?.label ?? 'its previous account';

  const choose = async (accountId: string) => {
    const target = store.account(accountId);
    if (!target || accountId === currentId) return;
    if (working) {
      const outcome = await openConfirm({
        title: `Continue on ${target.label}?`,
        description: `This stops the current turn and restarts the conversation on ${target.label}.`,
        confirmLabel: 'Continue',
      });
      if (!outcome.success) return;
    }
    await moveConversation(conversation.id, target, previousLabel);
  };

  return (
    <>
      <DropdownMenu.Separator />
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>
          <ArrowLeftRight className="size-4" />
          Continue on another account
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent width="content">
          <DropdownMenu.RadioGroup
            value={currentId}
            onValueChange={(value) => void choose(String(value))}
          >
            {store.accounts.map((account) => {
              const signedIn = store.isSignedIn(account);
              const usage = accountUsageSummary(store.usage.get(account.id));
              const label = accountOptionLabel(account, store.defaultAccountId);
              return (
                <DropdownMenu.RadioItem
                  key={account.id}
                  value={account.id}
                  disabled={!signedIn}
                  closeOnClick
                >
                  <span className="flex min-w-0 flex-col py-0.5">
                    <span className="truncate">{label}</span>
                    <span className="text-xs text-foreground-passive tabular-nums">
                      {signedIn ? (usage ?? 'Usage unknown') : 'Not signed in'}
                    </span>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    </>
  );
});
