import type { PluginIconAsset } from '@emdash/shared/plugins';
import { EmptyState } from '@emdash/ui/react/components';
import { SettingsCard, SettingsSection } from '@emdash/ui/react/patterns';
import { Sheet, Tooltip } from '@emdash/ui/react/primitives';
import React, { useState } from 'react';
import { isIssueIntegration } from '@core/features/integrations/api/browser/integration-display';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { supportsIntegrationReconnect } from '@core/manifests/browser/integration-auth-contributions';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { ConnectionStatus, IssueProviderType } from '@core/primitives/issue-providers/api';
import { IntegrationDetailSidebar } from './IntegrationDetailSidebar';
import { IntegrationGridCard } from './IntegrationGridCard';

export type IntegrationItem = {
  id: IssueProviderType;
  name: string;
  description: string;
  icon: PluginIconAsset;
  features: string[];
  isConfigured: boolean;
  isConfigurationKnown: boolean;
  isMutating: boolean;
  connectionError?: string;
  displayName?: string;
  displayDetail?: string;
  canReconnect: boolean;
  onConnect: () => void;
};

const IntegrationsCard: React.FC = () => {
  const {
    connectionStatus,
    integrationAccounts,
    isLoadingAccounts,
    accountsError,
    integrations: integrationMetadata,
    isIntegrationMutating,
  } = useIntegrationsContext();
  const [selectedProvider, setSelectedProvider] = useState<IssueProviderType | null>(null);
  const openIntegrationSetup = useOpenModal('integrationSetupModal');

  const integrations: IntegrationItem[] = integrationMetadata
    .filter(isIssueIntegration)
    .map((integration) => {
      const provider = integration.id;
      const status: ConnectionStatus = connectionStatus[provider] ?? {
        connected: false,
        capabilities: integration.issueCapabilities,
      };
      const isConfigured = (integrationAccounts[provider]?.length ?? 0) > 0;
      const isConfigurationKnown = !isLoadingAccounts && !accountsError;

      return {
        id: provider,
        name: integration.name,
        description: integration.description,
        icon: integration.icon,
        features: integration.features,
        isConfigured,
        isConfigurationKnown,
        isMutating: isIntegrationMutating(provider),
        connectionError: isConfigured ? status.error : undefined,
        displayName:
          integrationAccounts[provider]?.find((account) => account.isDefault)?.displayName ??
          status.displayName,
        displayDetail: status.displayDetail,
        canReconnect: supportsIntegrationReconnect(integration),
        onConnect: () => void openIntegrationSetup({ integration: provider }),
      };
    });

  const connectedIntegrations = integrations.filter((integration) => integration.isConfigured);
  const availableIntegrations = integrations.filter(
    (integration) => integration.isConfigurationKnown && !integration.isConfigured
  );
  const selectedIntegration = selectedProvider
    ? (integrations.find((integration) => integration.id === selectedProvider) ?? null)
    : null;

  function closeSheet() {
    setSelectedProvider(null);
  }

  return (
    <Tooltip.Provider delay={150}>
      <div className="flex flex-col gap-10">
        {accountsError ? (
          <SettingsCard>
            <EmptyState
              bare
              tone="error"
              className="py-6"
              label="Could not load your accounts"
              description="Integrations show here once their accounts load."
              details={accountsError.message}
            />
          </SettingsCard>
        ) : null}

        {connectedIntegrations.length > 0 && (
          <SettingsSection title="Connected" bare>
            <IntegrationList>
              {connectedIntegrations.map((integration) => (
                <IntegrationGridCard
                  key={integration.id}
                  integration={integration}
                  selected={integration.id === selectedProvider}
                  onSelect={() => setSelectedProvider(integration.id)}
                />
              ))}
            </IntegrationList>
          </SettingsSection>
        )}

        {accountsError ? null : (
          <SettingsSection
            title={connectedIntegrations.length > 0 ? 'More integrations' : 'Available'}
            description="Connect a service to pick its issues when you start a task."
            bare
          >
            <IntegrationList>
              {availableIntegrations.length > 0 ? (
                availableIntegrations.map((integration) => (
                  <IntegrationGridCard
                    key={integration.id}
                    integration={integration}
                    selected={integration.id === selectedProvider}
                    onSelect={() => setSelectedProvider(integration.id)}
                  />
                ))
              ) : isLoadingAccounts ? (
                <EmptyState tone="loading" label="Loading integrations…" bare className="py-6" />
              ) : (
                <EmptyState
                  label="Everything is connected"
                  description="Every available integration has an account."
                  bare
                  className="py-6"
                />
              )}
            </IntegrationList>
          </SettingsSection>
        )}
      </div>

      <Sheet.Root
        open={selectedIntegration !== null}
        onOpenChange={(open) => !open && closeSheet()}
      >
        <Sheet.Content className="[-webkit-app-region:no-drag]">
          {selectedIntegration && (
            <IntegrationDetailSidebar integration={selectedIntegration} onClose={closeSheet} />
          )}
        </Sheet.Content>
      </Sheet.Root>
    </Tooltip.Provider>
  );
};

/** A settings card holding one row per integration; rows bring their own hover step. */
function IntegrationList({ children }: { children: React.ReactNode }) {
  return (
    <SettingsCard padding="rows">
      <div className="flex flex-col gap-0.5">{children}</div>
    </SettingsCard>
  );
}

export default IntegrationsCard;
