import { getAgentUpdateActionState } from '@core/features/agents/api/browser/components/agent-selector/agent-install';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { UpdateAvailableBadge } from '@core/features/settings/browser/agents-page/agent-status-badge';
import { agentSupportsAcp, type AgentPayload } from '@core/primitives/agents/api';

/**
 * Row content (icon, name, and the facts that differ between agents, in words) — the
 * CollectionView shell owns interaction. Installed state is not repeated here: the list
 * sections already group by it. Every agent runs in a terminal, so only chat support is named.
 */
export const AgentRow = ({ agent }: { agent: AgentPayload }) => {
  const supportsChatUi = agentSupportsAcp(agent.capabilities);
  const installed = agent.status === 'available';

  const updates = agent.capabilities.hostDependency.updates;
  const updateStrategyKind = updates.kind === 'supported' ? updates.update.kind : 'none';
  const updateState = getAgentUpdateActionState({
    updateAvailable: agent.updateAvailable,
    updateStrategyKind,
    version: agent.version,
    latestVersion: agent.latestVersion,
    isUpdating: false,
  });

  const facts = [
    supportsChatUi ? 'Chat and terminal' : 'Terminal',
    installed && agent.version ? `v${agent.version}` : null,
  ].filter(Boolean);

  return (
    <div className="flex w-full min-w-0 items-center gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center">
        <AgentIcon id={agent.id} size={16} />
      </span>
      <span className="min-w-24 flex-1 truncate text-sm text-foreground">{agent.name}</span>
      <span className="flex min-w-0 items-center gap-3">
        {updateState.render && <UpdateAvailableBadge />}
        <span className="min-w-0 truncate text-xs text-foreground-passive tabular-nums">
          {facts.join(' · ')}
        </span>
      </span>
    </div>
  );
};
