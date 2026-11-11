import { Button, DropdownMenu, useToast } from '@emdash/ui/react/primitives';
import { CircleCheck, Ellipsis, RefreshCw, Trash2 } from 'lucide-react';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { getProjectsWireClient } from '@core/features/projects/api/browser/client';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { ProviderAccountSummary } from '@core/primitives/provider-accounts/api';
import { providerCredentialSourceLabel } from '@core/primitives/provider-accounts/browser/account-label';
import type { IntegrationItem } from './IntegrationsCard';

/**
 * Connected-account rows for one provider — GitHub included: every provider's
 * accounts render and mutate through the provider-generic integrations
 * surface backed by the common provider account service. Rows show the
 * account identity (avatar when the provider has one), the default marker and its source in words,
 * and one actions menu: make default, reconnect, remove.
 */
export function IntegrationAccountRows({
  integration,
  accounts,
}: {
  integration: IntegrationItem;
  accounts: ProviderAccountSummary[];
}) {
  const { disconnectIntegration, setDefaultIntegrationAccount, isIntegrationMutating } =
    useIntegrationsContext();
  const openConfirmRemove = useOpenModal('confirmActionModal');
  const openIntegrationSetup = useOpenModal('integrationSetupModal');
  const { toast } = useToast();
  const mutating = isIntegrationMutating(integration.id);

  const accountLabel = (account: ProviderAccountSummary) =>
    account.displayName === account.accountId
      ? (integration.displayName ?? `${integration.name} account`)
      : account.displayName;

  const setDefault = async (account: ProviderAccountSummary) => {
    const result = await setDefaultIntegrationAccount(integration.id, account.accountId);
    if (!result.success) {
      toast.error('Unable to update default account', { description: result.error });
      return;
    }
    toast(`Default ${integration.name} account updated`, {
      description: `Projects without an explicit account use ${accountLabel(account)} now.`,
    });
  };

  const confirmRemove = async (account: ProviderAccountSummary) => {
    let description = `This removes the saved ${integration.name} credentials for this account.`;
    try {
      const count = await (
        await getProjectsWireClient()
      ).countProjectsUsingProviderAccount({
        providerId: integration.id,
        accountId: account.accountId,
      });
      if (count > 0) {
        const projectLabel = count === 1 ? '1 project' : `${count} projects`;
        description = `This account is used by ${projectLabel}. Removing it will disable ${integration.name} features for those projects until another account is assigned.`;
      }
    } catch {}

    const outcome = await openConfirmRemove({
      title: `Remove ${accountLabel(account)}?`,
      description,
      confirmLabel: 'Remove',
    });
    if (!outcome.success) return;
    const result = await disconnectIntegration(integration.id, account.accountId);
    if (!result.success) {
      toast.error('Unable to remove account', { description: result.error });
      return;
    }
    toast(`${integration.name} account removed`, {
      description: `Removed ${accountLabel(account)}.`,
    });
  };

  const reconnect = (account: ProviderAccountSummary) => {
    void openIntegrationSetup({
      integration: integration.id,
      accountId: account.accountId,
      displayName: account.displayName !== account.accountId ? account.displayName : undefined,
    });
  };

  return (
    <ul className="flex flex-col gap-0.5" aria-label={`${integration.name} accounts`}>
      {accounts.map((account) => {
        const label = accountLabel(account);
        const facts = [
          account.isDefault && accounts.length > 1 ? 'Default' : null,
          account.displayDetail ?? 'Connected',
          account.credentialSource ? providerCredentialSourceLabel(account.credentialSource) : null,
        ].filter(Boolean);
        return (
          <li
            key={account.accountId}
            className="group/row -mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-hover"
          >
            <span className="flex size-7 shrink-0 items-center justify-center">
              {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" className="size-7 rounded-full" />
              ) : (
                <IntegrationIcon provider={integration.id} size={20} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{label}</p>
              <p className="truncate text-xs text-foreground-muted">{facts.join(' · ')}</p>
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon
                    className="shrink-0"
                    disabled={mutating}
                    aria-label={`${label} actions`}
                  />
                }
              >
                <Ellipsis className="size-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end" className="min-w-48">
                {accounts.length > 1 && !account.isDefault ? (
                  <DropdownMenu.Item onClick={() => void setDefault(account)}>
                    <CircleCheck className="size-4" />
                    Make default
                  </DropdownMenu.Item>
                ) : null}
                {integration.canReconnect ? (
                  <DropdownMenu.Item onClick={() => reconnect(account)}>
                    <RefreshCw className="size-4" />
                    Reconnect
                  </DropdownMenu.Item>
                ) : null}
                {(accounts.length > 1 && !account.isDefault) || integration.canReconnect ? (
                  <DropdownMenu.Separator />
                ) : null}
                <DropdownMenu.Item
                  variant="destructive"
                  onClick={() => void confirmRemove(account)}
                >
                  <Trash2 className="size-4" />
                  Remove account
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </li>
        );
      })}
    </ul>
  );
}
