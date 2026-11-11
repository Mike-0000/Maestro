import { InlineMarkdown } from '@emdash/ui/react/components';
import { Button, Combobox, Select, Tooltip } from '@emdash/ui/react/primitives';
import { ExternalLink, Link, Loader2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import {
  providerAccountReportingState,
  type ProviderAccountReportingState,
} from '@core/features/integrations/api/account-reporting';
import {
  getIntegrationName,
  isIssueIntegration,
} from '@core/features/integrations/api/browser/integration-display';
import { ProviderAccountStateEmpty } from '@core/features/integrations/contributions/browser/account-state';
import { IntegrationIcon } from '@core/features/integrations/contributions/browser/integration-icon';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { linkedIssueDisplayIdentifier, type LinkedIssue } from '@core/primitives/linked-issues/api';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { IssueStatusIndicator, toIssueStatus } from './issue-status-indicator';
import { getLinkedIssueMap, type LinkedIssueInfo } from './use-linked-issue-urls';
import { useIssueSearch } from './useIssueSearch';

export function IssueIdentifier({
  issue,
  className,
}: {
  issue: Pick<LinkedIssue, 'identifier' | 'displayIdentifier'>;
  className?: string;
}) {
  const identifier = linkedIssueDisplayIdentifier(issue);
  if (!identifier) return null;

  return (
    <span
      className={cn(
        'shrink-0 font-sans text-xs font-medium whitespace-nowrap text-foreground-muted',
        className
      )}
    >
      {identifier}
    </span>
  );
}

export function ProviderLogo({
  provider,
  className,
  size = 14,
}: {
  provider: LinkedIssue['provider'];
  className?: string;
  size?: number;
}) {
  const { integrationById } = useIntegrationsContext();

  return (
    <span
      role="img"
      aria-label={getIntegrationName(integrationById, provider)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-visible align-middle leading-none',
        className ?? 'h-3.5 w-3.5'
      )}
    >
      <IntegrationIcon provider={provider} size={size} />
    </span>
  );
}

export function LinkedIssueIndicator({ linkedTo }: { linkedTo: LinkedIssueInfo }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            aria-label={`Already linked to task: ${linkedTo.taskName}`}
            className="flex shrink-0 items-center text-foreground-passive"
          >
            <Link className="size-3.5" />
          </span>
        }
      />
      <Tooltip.Content>Already linked to task: {linkedTo.taskName}</Tooltip.Content>
    </Tooltip.Root>
  );
}

export function IssueRow({ issue, linkedTo }: { issue: LinkedIssue; linkedTo?: LinkedIssueInfo }) {
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-2">
        {issue.status ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={<IssueStatusIndicator status={toIssueStatus(issue.status)} />}
            />
            <Tooltip.Content>{issue.status}</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        <span className="flex min-w-0 items-center gap-2">
          {issue.title ? <span className="truncate">{issue.title}</span> : null}
          {linkedTo ? <LinkedIssueIndicator linkedTo={linkedTo} /> : null}
        </span>
      </span>
      <IssueIdentifier issue={issue} className="text-foreground-passive" />
    </span>
  );
}

export type IssueSelectorTriggerContext = {
  issueProvider: LinkedIssue['provider'] | null;
  connectedProviderCount: number;
  isProviderDisabled: (p: LinkedIssue['provider']) => boolean;
  setSelectedIssueProvider: (p: LinkedIssue['provider']) => void;
};

export interface IssueSelectorProps {
  value: LinkedIssue | null;
  onValueChange: (issue: LinkedIssue | null) => void;
  projectId?: string;
  repositoryUrl: string;
  projectPath?: string;
  /** Skip "already linked" indicator for this task — useful when re-selecting the same task's issue. */
  excludeTaskId?: string;
  disabled?: boolean;
  renderSelectedValue?: (issue: LinkedIssue) => ReactNode;
  renderPlaceholder?: (ctx: IssueSelectorTriggerContext) => ReactNode;
  /**
   * Classes for the trigger button itself, for callers that make the whole trigger one field
   * (its border, fill and focus ring) and render bare content.
   */
  triggerClassName?: string;
}

export const IssueSelector = observer(function IssueSelector({
  projectId,
  repositoryUrl,
  projectPath = '',
  value,
  onValueChange,
  excludeTaskId,
  disabled,
  renderSelectedValue,
  renderPlaceholder,
  triggerClassName,
}: IssueSelectorProps) {
  const linkedIssueMap = getLinkedIssueMap(projectId, excludeTaskId);
  const { integrationById, integrations } = useIntegrationsContext();
  const issueProviderOrder = useMemo(
    () => integrations.filter(isIssueIntegration).map((integration) => integration.id),
    [integrations]
  );
  const {
    issues,
    error,
    accountUnavailable,
    issueProvider,
    hasAnyIntegration,
    isProviderLoading,
    isProviderDisabled,
    connectedProviderCount,
    handleSetSearchTerm,
    setSelectedIssueProvider,
  } = useIssueSearch(repositoryUrl, projectPath, projectId);

  // §7 reporting matrix over the resolver provenance the Wire payload
  // carries (spec: github-git-settings §7). Silent rows never cross the
  // Wire, so any payload here renders a visible state.
  const accountProviderName = issueProvider
    ? getIntegrationName(integrationById, issueProvider)
    : 'Integration';
  const accountState: ProviderAccountReportingState | null = accountUnavailable
    ? providerAccountReportingState(
        accountProviderName,
        accountUnavailable.provenance,
        accountUnavailable.accountsConnected
      )
    : null;

  const [comboboxOpen, setComboboxOpen] = useState(false);
  const providerSelectOpenRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSelectIssueProvider = useCallback(
    (provider: LinkedIssue['provider']) => {
      setSelectedIssueProvider(provider);
      if (value?.provider !== provider) {
        onValueChange(null);
      }
    },
    [setSelectedIssueProvider, value, onValueChange]
  );

  const leftAddon = issueProvider ? (
    connectedProviderCount > 1 ? (
      <Select.Root
        value={issueProvider}
        onValueChange={(v) => v && handleSelectIssueProvider(v as LinkedIssue['provider'])}
        onOpenChange={(open) => {
          providerSelectOpenRef.current = open;
          if (open) {
            setComboboxOpen(true);
          } else {
            requestAnimationFrame(() => inputRef.current?.focus());
          }
        }}
      >
        <Select.Trigger aria-label="Select issue provider" size="xs" className="gap-1 px-1.5">
          <ProviderLogo provider={issueProvider} className="size-3.5" />
        </Select.Trigger>
        <Select.Content>
          {issueProviderOrder.map((p) => (
            <Select.Item key={p} value={p} disabled={isProviderDisabled(p)}>
              <ProviderLogo provider={p} className="size-4" size={16} />
              <span>{getIntegrationName(integrationById, p)}</span>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    ) : (
      <span className="mx-1.5 flex items-center">
        <ProviderLogo provider={issueProvider} className="h-3.5 w-3.5" />
      </span>
    )
  ) : null;

  const triggerContext: IssueSelectorTriggerContext = {
    issueProvider,
    connectedProviderCount,
    isProviderDisabled,
    setSelectedIssueProvider,
  };

  // Default faces (the title bar's task popover): the linked issue as plain text that comes
  // to full strength on hover, or a muted "Link an issue" action. No dashed boxes, no shadows.
  const selectedContent = value ? (
    renderSelectedValue ? (
      renderSelectedValue(value)
    ) : (
      <div className="flex w-full min-w-0 items-start py-1 text-left text-sm">
        <SelectedIssueValue issue={value} />
      </div>
    )
  ) : null;

  const placeholderContent = renderPlaceholder ? (
    renderPlaceholder(triggerContext)
  ) : (
    <span className="flex h-7 items-center gap-2 text-sm text-foreground-muted transition-colors hover:text-foreground">
      <Link className="size-3.5 shrink-0 text-foreground-passive" />
      Link an issue
    </span>
  );

  // No overflow clipping here: it would cut the trigger's focus ring. Rows truncate their text.
  return (
    <div className="max-w-full min-w-0">
      {hasAnyIntegration ? (
        <Combobox.Root
          autoHighlight
          items={issues}
          filter={null}
          itemToStringLabel={(issue: LinkedIssue | null) =>
            issue ? `${issue.identifier} ${issue.title}` : ''
          }
          value={value}
          onValueChange={(next: LinkedIssue | null) => onValueChange(next)}
          onInputValueChange={(val: string, { reason }: { reason: string }) => {
            if (reason !== 'item-press') handleSetSearchTerm(val);
          }}
          disabled={disabled || !hasAnyIntegration}
          open={comboboxOpen}
          onOpenChange={(open) => {
            if (!open && providerSelectOpenRef.current) return;
            setComboboxOpen(open);
          }}
        >
          <Combobox.Trigger
            render={
              <button
                type="button"
                className={cn(
                  'flex w-full min-w-0 text-left outline-none',
                  triggerClassName ?? 'rounded-sm focus-visible:ring-2 focus-visible:ring-ring'
                )}
              >
                <Combobox.Value placeholder={placeholderContent}>
                  {value ? selectedContent : null}
                </Combobox.Value>
              </button>
            }
          />
          <Combobox.Content
            side="bottom"
            width="content-at-least-trigger"
            className="max-w-[min(32rem,var(--available-width))]"
            collisionAvoidance={{ side: 'shift' }}
          >
            <Combobox.Input
              leftAddon={leftAddon}
              rightAddon={
                isProviderLoading ? (
                  <Loader2 className="size-3.5 text-foreground-passive motion-safe:animate-spin" />
                ) : undefined
              }
              inputRef={inputRef}
              showClear={!!value}
              showTrigger={false}
              placeholder={`Search ${
                issueProvider ? getIntegrationName(integrationById, issueProvider) : 'issues'
              }…`}
              disabled={!hasAnyIntegration}
            />
            <Combobox.Empty>
              {accountState && accountState.kind !== 'silent' ? (
                <ProviderAccountStateEmpty
                  state={accountState}
                  projectId={projectId}
                  providerId={issueProvider ?? ''}
                  providerName={accountProviderName}
                />
              ) : error ? (
                <span className="flex items-center gap-2 px-3 text-foreground-muted">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground-error" />
                  {error}
                </span>
              ) : (
                <span>No issues found</span>
              )}
            </Combobox.Empty>
            <Combobox.List>
              {(issue: LinkedIssue) => {
                const linkedTo = linkedIssueMap.get(issue.url);
                return (
                  <Combobox.Item key={issue.identifier} value={issue} showCheck={false}>
                    <IssueRow issue={issue} linkedTo={linkedTo} />
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Content>
        </Combobox.Root>
      ) : error ? (
        <span role="alert" className="flex items-center gap-2 text-sm text-foreground-muted">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground-error" />
          {error}
        </span>
      ) : isProviderLoading ? (
        <span role="status" className="flex items-center gap-2 text-sm text-foreground-muted">
          <Loader2 className="size-3.5 text-foreground-passive motion-safe:animate-spin" /> Loading
          integration accounts…
        </span>
      ) : (
        <ConnectIssueIntegrationPlaceholder />
      )}
    </div>
  );
});

/**
 * A linked issue in two lines: status mark, title and its tracker id, then one line of the
 * description in the helper role. The open-in-browser glyph shows on hover or focus.
 */
export function SelectedIssueValue({ issue }: { issue: LinkedIssue }) {
  return (
    <div className="flex w-full min-w-0 gap-2">
      {issue.status ? (
        <span className="mt-0.5 flex h-5 shrink-0 items-center">
          <IssueStatusIndicator status={toIssueStatus(issue.status)} />
        </span>
      ) : null}
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center justify-between gap-3">
          <span className="group/issue-title flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-foreground">{issue.title}</span>
            <span
              role="link"
              tabIndex={issue.url ? 0 : -1}
              aria-label="Open issue in browser"
              aria-disabled={!issue.url || undefined}
              className="shrink-0 rounded-xs text-foreground-passive opacity-0 transition-opacity outline-none group-hover/issue-title:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                if (issue.url) void openExternal(issue.url);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !issue.url) return;
                event.stopPropagation();
                void openExternal(issue.url);
              }}
            >
              <ExternalLink className="size-3" />
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-foreground-passive">
            <ProviderLogo provider={issue.provider} className="size-3 opacity-60" />
            <IssueIdentifier issue={issue} className="text-foreground-passive" />
          </span>
        </span>
        {issue.description ? (
          <InlineMarkdown
            content={issue.description}
            className="line-clamp-1 min-w-0 text-xs text-foreground-muted"
          />
        ) : null}
      </div>
    </div>
  );
}

/** No issue tracker connected: the trackers' marks and one text action to connect one. */
export function ConnectIssueIntegrationPlaceholder() {
  const { navigate } = useNavigate();
  const { integrations } = useIntegrationsContext();
  const issueProviderOrder = integrations
    .filter(isIssueIntegration)
    .map((integration) => integration.id);

  return (
    <div className="flex min-h-8 w-full flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex items-center [&>span]:ring-2 [&>span]:ring-(--em-surface) [&>span:not(:first-child)]:-ml-1">
        {issueProviderOrder.map((provider) => (
          <span
            key={provider}
            className="relative flex size-5 items-center justify-center overflow-hidden rounded-full bg-surface-emphasis"
          >
            <ProviderLogo provider={provider} className="size-3" />
          </span>
        ))}
      </div>
      <span className="text-sm text-foreground-muted">No issue tracker connected.</span>
      <Button
        variant="text"
        size="xs"
        onClick={() => navigate(settingsViewDef({ tab: 'integrations' }))}
      >
        Configure integrations
      </Button>
    </div>
  );
}
