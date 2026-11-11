import type {
  McpCatalogEntry,
  McpProvidersResponse,
  McpServer,
} from '@emdash/core/primitives/mcp/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { ExternalLink } from 'lucide-react';
import React from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { McpServerIcon } from '@core/features/mcp/browser/mcpIcons';

interface McpCardProps {
  server?: McpServer;
  /** Host-scoped provider list from the owning panel's `useMcps(host)`. */
  providers: McpProvidersResponse[];
  catalogEntry?: McpCatalogEntry;
  onEdit?: (server: McpServer) => void;
  onAdd?: (entry: McpCatalogEntry) => void;
}

const MAX_VISIBLE_PROVIDERS = 5;

function getTransport(server?: McpServer, entry?: McpCatalogEntry): 'stdio' | 'http' {
  if (server) return server.transport;
  const cfg = entry?.defaultConfig;
  if (cfg?.type === 'http' || (cfg && 'url' in cfg && !('command' in cfg))) return 'http';
  return 'stdio';
}

/**
 * One MCP server as a row of its settings card: the server's mark, its name with the transport
 * in the caption role, one line of what it does, and on the right the agents it syncs to (added
 * servers) or a quiet "Add" (recommended ones). The whole row opens the editor sheet; the docs
 * link appears on hover or focus.
 */
export const McpCard: React.FC<McpCardProps> = ({
  server,
  providers,
  catalogEntry,
  onEdit,
  onAdd,
}) => {
  const name = server?.name ?? catalogEntry?.name ?? 'Unknown';
  const description = catalogEntry?.description ?? (server ? `${server.transport} server` : '');
  const isInstalled = !!server;
  const transport = getTransport(server, catalogEntry);
  const docsUrl = catalogEntry?.docsUrl;
  const agentIds = new Set(providers.map((provider) => provider.id));
  const syncedProviders = (server?.providers ?? []).filter((id) =>
    agentIds.has(id)
  ) as AgentProviderId[];
  const visibleProviders = syncedProviders.slice(0, MAX_VISIBLE_PROVIDERS);
  const hiddenProviderCount = syncedProviders.length - visibleProviders.length;
  const providerNames = syncedProviders
    .map((id) => providers.find((provider) => provider.id === id)?.name ?? id)
    .join(', ');

  const handleClick = () => {
    if (isInstalled && server && onEdit) {
      onEdit(server);
    } else if (catalogEntry && onAdd) {
      onAdd(catalogEntry);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={isInstalled ? `Edit ${name}` : `Add ${name}`}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className="group -mx-2 flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring"
    >
      <McpServerIcon name={name} iconKey={catalogEntry?.key ?? server?.name} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
          <span className="shrink-0 font-mono text-tiny text-foreground-passive">{transport}</span>
        </div>
        {description && <p className="line-clamp-1 text-xs text-foreground-muted">{description}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {docsUrl && (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  size="sm"
                  icon
                  variant="ghost"
                  className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
                    window.open(docsUrl, '_blank', 'noopener,noreferrer');
                  }}
                  aria-label={`View ${name} docs`}
                />
              }
            >
              <ExternalLink className="size-3.5" />
            </Tooltip.Trigger>
            <Tooltip.Content>View docs</Tooltip.Content>
          </Tooltip.Root>
        )}
        {isInstalled ? (
          syncedProviders.length > 0 ? (
            <span
              className="flex items-center gap-1"
              title={`Synced to ${providerNames}`}
              aria-label={`Synced to ${providerNames}`}
              role="img"
            >
              {visibleProviders.map((id) => (
                <AgentIcon key={id} id={id} size={14} className="rounded-xs" />
              ))}
              {hiddenProviderCount > 0 && (
                <span className="text-tiny text-foreground-passive tabular-nums">
                  +{hiddenProviderCount}
                </span>
              )}
            </span>
          ) : (
            <span className="text-tiny text-foreground-passive">Not synced</span>
          )
        ) : (
          <span className="text-xs text-foreground-muted transition-colors group-hover:text-foreground">
            Add
          </span>
        )}
      </div>
    </div>
  );
};
