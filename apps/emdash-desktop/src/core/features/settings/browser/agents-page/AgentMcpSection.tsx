import type { HostRef } from '@emdash/core/primitives/host/api';
import type { McpServer } from '@emdash/core/primitives/mcp/api';
import { Button, Spinner } from '@emdash/ui/react/primitives';
import { Globe, Terminal, X } from 'lucide-react';
import { useAgentMcps } from '@core/features/agents/api/browser/use-agent-mcps';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { AgentSheetSection } from './agent-sheet-section';

/** One MCP server: transport glyph, name, transport in words, and a remove action on hover. */
function McpServerRow({
  server,
  isRemoving,
  onRemove,
}: {
  server: McpServer;
  isRemoving: boolean;
  onRemove: () => void;
}) {
  const Icon = server.transport === 'http' ? Globe : Terminal;

  return (
    <li className="group/row -mx-2 flex h-8 items-center gap-2 rounded-md px-2 transition-colors hover:bg-surface-hover">
      <Icon className="size-3.5 shrink-0 text-foreground-passive" aria-hidden="true" />
      <span className="min-w-0 truncate text-sm text-foreground" title={server.name}>
        {server.name}
      </span>
      <span className="shrink-0 text-xs text-foreground-passive">{server.transport}</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon
        disabled={isRemoving}
        className="ml-auto shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 disabled:opacity-100"
        onClick={onRemove}
        aria-label={`Remove ${server.name} from this agent`}
      >
        {isRemoving ? (
          <Spinner size="sm" aria-hidden="true" />
        ) : (
          <X className="size-3.5" aria-hidden="true" />
        )}
      </Button>
    </li>
  );
}

export function useManageMcpSettingsNavigation(): () => void {
  const { navigate } = useNavigate();
  return () => navigate(settingsViewDef({ tab: 'mcp' }));
}

export function AgentMcpSection({
  agentId,
  host,
  onManage,
}: {
  agentId: string;
  host: HostRef;
  onManage?: () => void;
}) {
  const { servers, isLoading, removeServer, removingServerName } = useAgentMcps(agentId, host);

  return (
    <AgentSheetSection
      title="MCP servers"
      action={
        onManage ? (
          <Button type="button" variant="text" size="xs" onClick={onManage}>
            Manage in Settings
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner size="sm" className="text-foreground-passive" />
          Loading servers…
        </p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-foreground-muted">No MCP servers for this agent yet.</p>
      ) : (
        <ul className="flex flex-col">
          {servers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              isRemoving={removingServerName === server.name}
              onRemove={() => removeServer(server.name)}
            />
          ))}
        </ul>
      )}
    </AgentSheetSection>
  );
}
