import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Sheet, Spinner } from '@emdash/ui/react/primitives';
import { Plus } from 'lucide-react';
import { ISSUE_FEATURE_LABELS } from '@core/features/integrations/api/browser/integration-display';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { IntegrationAccountRows } from './IntegrationAccountsSection';
import type { IntegrationItem } from './IntegrationsCard';

/**
 * The integration sheet: what the service is and does, then its accounts. With no account the
 * one move is to connect one (the sheet's primary action); with accounts, adding another is a
 * quiet action under the list. The sheet's own close button dismisses it.
 */
export function IntegrationDetailSidebar({
  integration,
}: {
  integration: IntegrationItem;
  /** Kept for callers; the sheet header's close button closes the sheet. */
  onClose: () => void;
}) {
  const { integrationAccounts, isLoadingAccounts, accountsError } = useIntegrationsContext();
  const accounts = integrationAccounts[integration.id] ?? [];
  const accountLabel = accounts.length > 1 ? 'Accounts' : 'Account';
  const features = integration.features.map((feature) => ISSUE_FEATURE_LABELS[feature] ?? feature);

  return (
    <>
      <Sheet.Header>
        <div className="flex items-center gap-3">
          <IntegrationIcon provider={integration.id} icon={integration.icon} size={24} />
          <Sheet.Title>{integration.name}</Sheet.Title>
        </div>
        <p className="text-sm text-foreground-muted">{integration.description}</p>
        {features.length > 0 ? (
          <p className="text-xs text-foreground-passive">{features.join(' · ')}</p>
        ) : null}
      </Sheet.Header>

      <Sheet.Body>
        <section className="flex flex-col gap-3" aria-labelledby="integration-accounts-heading">
          <h3 id="integration-accounts-heading" className="text-sm font-semibold text-foreground">
            {accountLabel}
          </h3>

          {isLoadingAccounts ? (
            <p className="flex items-center gap-2 text-sm text-foreground-muted">
              <Spinner size="sm" className="text-foreground-passive" />
              Loading accounts…
            </p>
          ) : null}

          {accountsError ? (
            <p role="alert" className="flex items-start gap-2 text-sm text-foreground-muted">
              <StateGlyph state="error" className="mt-0.5" />
              <span>
                <span className="text-foreground">Could not load accounts.</span>{' '}
                {accountsError.message}
              </span>
            </p>
          ) : null}

          {accounts.length > 0 && (
            <IntegrationAccountRows integration={integration} accounts={accounts} />
          )}

          {!isLoadingAccounts && !accountsError ? (
            accounts.length > 0 ? (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5"
                  onClick={integration.onConnect}
                  disabled={integration.isMutating}
                >
                  {integration.isMutating ? <Spinner size="sm" /> : <Plus className="size-3.5" />}
                  Add another {integration.name} account
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-4">
                <p className="text-sm text-foreground-muted">
                  No account yet. Connect {integration.name} to start using this integration.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={integration.onConnect}
                  disabled={integration.isMutating}
                >
                  {integration.isMutating ? <Spinner size="sm" /> : null}
                  Connect {integration.name}
                </Button>
              </div>
            )
          ) : null}
        </section>
      </Sheet.Body>
    </>
  );
}
