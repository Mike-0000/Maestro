import { EmptyState } from '@emdash/ui/react/components';
import { PageLayout, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, DropdownMenu, Switch, toast } from '@emdash/ui/react/primitives';
import { Ellipsis, LogIn, Pencil, Trash2, UserRoundCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { ClaudeAccount, ClaudeAccountsError } from '../api/types';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { accountIdentityLine, claudeAccountsErrorMessage } from './account-model';
import { ClaudeUsageRefresh, ClaudeUsageRow, useClaudeUsageWatch } from './claude-usage-rows';
import { useClaudeAccountSignIn } from './use-claude-account-sign-in';
import { useNow } from './use-now';

type AccountActionResult = { success: true } | { success: false; error: ClaudeAccountsError };

/** Runs one account change and reports a failure in words; true when it went through. */
async function runAccountAction(
  failureTitle: string,
  action: () => Promise<AccountActionResult>
): Promise<boolean> {
  try {
    const result = await action();
    if (result.success) return true;
    toast.error(failureTitle, { description: claudeAccountsErrorMessage(result.error) });
  } catch {
    toast.error(failureTitle, { description: 'Something went wrong. Try again.' });
  }
  return false;
}

const ClaudeAccountRow = observer(function ClaudeAccountRow({
  account,
}: {
  account: ClaudeAccount;
}) {
  const store = getClaudeAccountsStore();
  const signIn = useClaudeAccountSignIn();
  const openLabelModal = useOpenModal('claudeAccountLabelModal');
  const openConfirm = useOpenModal('confirmActionModal');
  const [busy, setBusy] = useState(false);
  const isDefault = account.id === store.defaultAccountId;
  const signedIn = store.isSignedIn(account);

  const makeDefault = async () => {
    setBusy(true);
    const done = await runAccountAction("Couldn't switch account", () =>
      store.setDefault(account.id)
    );
    setBusy(false);
    if (done) toast(`New agents now use ${account.label}`);
  };

  const remove = async () => {
    const outcome = await openConfirm({
      title: `Remove ${account.label}?`,
      description:
        'This removes its sign-in from this computer. Conversations on it move to the default account.' +
        (isDefault ? ' The primary account becomes the default.' : ''),
      confirmLabel: 'Remove',
    });
    if (!outcome.success) return;
    setBusy(true);
    const done = await runAccountAction("Couldn't remove account", () => store.remove(account.id));
    setBusy(false);
    if (done) toast(`${account.label} removed`);
  };

  return (
    <SettingsRow
      label={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{account.label}</span>
          {/* Words, not a chip: which account new agents start on. */}
          {isDefault && store.hasMultipleAccounts ? (
            <span className="shrink-0 text-xs font-normal text-foreground-muted">
              Used by new agents
            </span>
          ) : null}
        </span>
      }
      description={accountIdentityLine(account, signedIn)}
      control={
        <div className="flex items-center justify-end gap-1.5">
          {!signedIn && (
            <Button
              type="button"
              variant="text"
              size="sm"
              disabled={busy}
              onClick={() => void signIn(account)}
            >
              Sign in
            </Button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon
                  disabled={busy}
                  aria-label={`Actions for ${account.label}`}
                />
              }
            >
              <Ellipsis aria-hidden />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" width="content">
              {!isDefault && (
                <DropdownMenu.Item disabled={!signedIn} onClick={() => void makeDefault()}>
                  <UserRoundCheck aria-hidden />
                  Use for new agents
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item onClick={() => void signIn(account)}>
                <LogIn aria-hidden />
                {signedIn ? 'Sign in again' : 'Sign in'}
              </DropdownMenu.Item>
              {account.kind === 'extra' && (
                <>
                  <DropdownMenu.Item onClick={() => void openLabelModal({ account })}>
                    <Pencil aria-hidden />
                    Rename
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item variant="destructive" onClick={() => void remove()}>
                    <Trash2 aria-hidden />
                    Remove
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      }
    />
  );
});

/**
 * Settings > Claude accounts: the accounts themselves (sign in, rename, remove, pick the one
 * new agents use), then each account's usage.
 */
export const ClaudeAccountsSettingsPage = observer(function ClaudeAccountsSettingsPage() {
  const store = getClaudeAccountsStore();
  const signIn = useClaudeAccountSignIn();
  const openLabelModal = useOpenModal('claudeAccountLabelModal');
  const now = useNow();
  useClaudeUsageWatch();

  // Sign-in state is as old as the last time Claude Code was asked, so ask when the page opens.
  const loaded = store.state !== null;
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void (async () => {
      for (const account of store.accounts) {
        if (cancelled) return;
        await store.refreshIdentity(account.id).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, store]);

  const addAccount = async () => {
    const outcome = await openLabelModal({});
    if (outcome.success) await signIn(outcome.data);
  };

  return (
    <div className="flex flex-col pb-16">
      <PageLayout.Header
        sticky
        title="Claude accounts"
        description="Run agents on more than one Claude subscription. Each account keeps its own sign-in, and new agents use the default one."
      />
      {!loaded ? (
        <EmptyState tone="loading" label="Loading accounts…" className="min-h-48" />
      ) : (
        <div className="flex flex-col gap-10">
          <SettingsSection title="Accounts">
            {store.accounts.map((account) => (
              <ClaudeAccountRow key={account.id} account={account} />
            ))}
            <SettingsRow
              label="Switch accounts at a usage limit"
              description={
                store.hasMultipleAccounts
                  ? 'When a conversation hits its limit, continue it on the account with the most usage left.'
                  : 'When a conversation hits its limit, continue it on the account with the most usage left. Add another account to use this.'
              }
              control={
                <Switch
                  checked={store.autoSwitchOnLimit}
                  disabled={!store.hasMultipleAccounts}
                  onCheckedChange={(enabled) => {
                    void store.setAutoSwitchOnLimit(enabled).then((done) => {
                      if (!done) {
                        toast.error("Couldn't change the setting", {
                          description: 'Something went wrong. Try again.',
                        });
                      }
                    });
                  }}
                />
              }
            />
            <SettingsRow
              label="Add an account"
              description="Sign in to another Claude subscription. Your other accounts stay signed in."
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void addAccount()}
                >
                  Add account
                </Button>
              }
            />
          </SettingsSection>
          <SettingsSection title="Usage">
            <ClaudeUsageRefresh now={now} className="-mr-1.5 -mb-3 justify-end" />
            {store.accounts.map((account) => (
              <ClaudeUsageRow key={account.id} account={account} now={now} />
            ))}
          </SettingsSection>
        </div>
      )}
    </div>
  );
});
