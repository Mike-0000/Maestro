import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import React from 'react';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { AppSettings } from '@core/services/settings/api';
import { SettingRow } from '../components/SettingRow';

export const DefaultAgentSelector: React.FC = () => {
  const {
    value: defaultAgentValue,
    update,
    isLoading,
    isSaving,
  } = useAppSettingsKey('defaultAgent');
  // App-level preference: the default agent is validated against the local host by design.
  const { data: agents } = useAgents(LOCAL_HOST_REF);

  const defaultAgent =
    defaultAgentValue && agents?.some((agent) => agent.id === defaultAgentValue)
      ? defaultAgentValue
      : null;

  const handleChange = (agent: AgentProviderId) => {
    update(agent as AppSettings['defaultAgent']);
  };

  return (
    <SettingRow
      title="Default agent"
      description="Selected by default when creating a new task."
      control={
        <div className="w-56 shrink-0">
          <AgentSelector
            value={defaultAgent}
            onChange={handleChange}
            disabled={isLoading || isSaving}
            className="w-full"
          />
        </div>
      }
    />
  );
};
