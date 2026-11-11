import { StateGlyph } from '@emdash/ui/react/components';
import { Tooltip } from '@emdash/ui/react/primitives';
import { ChevronRight } from 'lucide-react';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import type { IntegrationItem } from './IntegrationsCard';

/**
 * One integration in the Integrations page list: logo, name, and one quiet line (the connected
 * account, or what the service is). The whole row opens the integration's sheet; a connection
 * problem shows as the error mark and words, never a coloured badge.
 */
export function IntegrationGridCard({
  integration,
  selected,
  onSelect,
}: {
  integration: IntegrationItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const detail = integration.isConfigured
    ? [integration.displayName, integration.displayDetail].filter(Boolean).join(' · ') ||
      'Connected'
    : integration.description;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={selected || undefined}
      className="group/row -mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-[active=true]:bg-surface-selected"
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        <IntegrationIcon provider={integration.id} icon={integration.icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{integration.name}</span>
        <span className="truncate text-xs text-foreground-muted">{detail}</span>
      </span>
      {integration.connectionError ? (
        <ConnectionIssueIndicator
          providerName={integration.name}
          error={integration.connectionError}
        />
      ) : !integration.isConfigured ? (
        <span className="shrink-0 text-xs text-foreground-passive group-hover/row:text-foreground-muted">
          Connect
        </span>
      ) : null}
      <ChevronRight
        className="size-4 shrink-0 text-foreground-passive transition-colors group-hover/row:text-foreground-muted"
        aria-hidden
      />
    </button>
  );
}

/** The error mark and "Needs attention" in words; the tooltip carries the provider's message. */
export function ConnectionIssueIndicator({
  providerName,
  error,
}: {
  providerName: string;
  error: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-error"
            aria-label={`${providerName} connection issue`}
          >
            <StateGlyph state="error" size="sm" />
            Needs attention
          </span>
        }
      />
      <Tooltip.Content side="top" className="max-w-72">
        {error || 'Connection issue'}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
