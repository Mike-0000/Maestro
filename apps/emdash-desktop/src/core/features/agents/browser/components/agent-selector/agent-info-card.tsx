import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { Button, Switch } from '@emdash/ui/react/primitives';
import { ExternalLink } from 'lucide-react';
import React from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgentInstallationStatus } from '@core/features/agents/api/browser/use-agent-installation-statuses';
import { useAgent } from '@core/features/agents/api/browser/use-agents';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { InstallSection } from '@core/features/settings/contributions/browser/agents-page/InstallSection';
import type { AppSettings } from '@core/services/settings/api';

type Props = {
  id: AgentProviderId;
  connectionId?: string;
};

export const AgentInfoCard: React.FC<Props> = ({ id, connectionId }) => {
  const host = hostRefFromConnectionId(connectionId);
  const { data: payload } = useAgent(id, host);
  const { data: statusData } = useAgentInstallationStatus(id, host);
  const {
    value: defaultAgent,
    update: updateDefaultAgent,
    isLoading: isDefaultAgentLoading,
    isSaving: isDefaultAgentSaving,
  } = useAppSettingsKey('defaultAgent');

  const isInstalled = (statusData?.status ?? payload?.status) === 'available';
  const isDefaultAgent = defaultAgent === id;
  const title = payload?.name ?? id;
  const description = payload?.description ?? null;
  const docUrl = payload?.websiteUrl ?? null;

  function handleSetDefaultAgent(checked: boolean) {
    if (!checked || isDefaultAgent) return;
    updateDefaultAgent(id as AppSettings['defaultAgent']);
  }

  // One quiet card (design brief 2.10): the agent's name as the card headline, the website as
  // a text action, a sentence of description, then the default-agent switch as a plain row
  // and the install details. No inner boxes; space separates the groups. The popover around
  // it owns the padding.
  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon id={id} size={16} className="rounded-xs" />
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </div>
        {docUrl && (
          <Button
            variant="text"
            size="xs"
            className="shrink-0 gap-1"
            onClick={() => window.open(docUrl, '_blank', 'noreferrer')}
          >
            Website
            <ExternalLink className="size-3" aria-hidden="true" />
          </Button>
        )}
      </div>

      {description ? (
        <p className="-mt-1 text-xs leading-relaxed text-pretty text-foreground-muted">
          {description}
        </p>
      ) : null}

      <div className="flex min-h-7 items-center justify-between gap-3">
        <label
          htmlFor={`set-default-agent-${id}`}
          className="min-w-0 flex-1 text-sm text-foreground"
        >
          Set as the default agent
        </label>
        <Switch
          id={`set-default-agent-${id}`}
          size="sm"
          checked={isDefaultAgent}
          disabled={!isInstalled || isDefaultAgentLoading || isDefaultAgentSaving}
          onCheckedChange={handleSetDefaultAgent}
        />
      </div>

      {payload && (
        <InstallSection
          agentId={id}
          connectionId={connectionId}
          agentPayload={payload}
          installOptions={payload.installOptions}
          installDocs={payload.installDocs}
          hideOverrideOptions={!isInstalled || !!connectionId}
          compact
        />
      )}
    </div>
  );
};
