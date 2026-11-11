import { sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import type { McpProvidersResponse } from '@emdash/core/primitives/mcp/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { Button, Field } from '@emdash/ui/react/primitives';
import { X } from 'lucide-react';
import React from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { cn } from '@core/primitives/styling/browser/cn';

interface SyncToAgentsSectionProps {
  host: HostRef;
  providers: McpProvidersResponse[];
  selectedProviders: string[];
  onToggle: (id: string) => void;
  onSetAll: (ids: string[]) => void;
}

export const SyncToAgentsSection: React.FC<SyncToAgentsSectionProps> = ({
  host,
  providers,
  selectedProviders,
  onToggle,
  onSetAll,
}) => {
  const selectedProviderIds = new Set(selectedProviders);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const selected = selectedProviders
    .map((id) => providersById.get(id))
    .filter((provider): provider is McpProvidersResponse => Boolean(provider));
  const installedProviders = providers.filter((provider) => provider.installed);

  return (
    <Field.Root>
      <div className="flex items-baseline justify-between gap-3">
        <Field.Label>Sync to agents</Field.Label>
        <Button
          type="button"
          variant="text"
          size="xs"
          disabled={installedProviders.length === 0}
          onClick={() => onSetAll(installedProviders.map((provider) => provider.id))}
        >
          Sync to all installed agents
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((provider) => (
          <span
            key={provider.id}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-hover pr-1 pl-2 text-xs text-foreground"
            title={`Synced to ${provider.name}`}
          >
            <AgentIcon id={provider.id as AgentProviderId} size={14} className="rounded-xs" />
            <span>{provider.name}</span>
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded-full text-foreground-passive transition-colors outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onToggle(provider.id)}
              aria-label={`Remove ${provider.name} from synced agents`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <AgentSelector
          value={null}
          appearance="quiet"
          placeholder={selected.length > 0 ? 'Add an agent' : 'Choose an agent'}
          connectionId={sshConnectionIdOf(host)}
          onChange={(id) => {
            if (!selectedProviderIds.has(id)) onToggle(id);
          }}
          className={cn('text-xs', selected.length > 0 && 'ml-0')}
          contentClassName="w-72"
        />
      </div>
      {selected.length === 0 && (
        <Field.Description>Choose at least one agent to add the server to.</Field.Description>
      )}
    </Field.Root>
  );
};
