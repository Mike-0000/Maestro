import { Button, Popover } from '@emdash/ui/react/primitives';
import { Gauge } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactElement } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { ClaudeUsagePanel } from '../../browser/claude-usage-panel';
import { ClaudeUsageRefresh, useClaudeUsageWatch } from '../../browser/claude-usage-rows';
import { headlineUsage, type UsageSeverity } from '../../browser/usage-model';
import { useNow } from '../../browser/use-now';
import { getClaudeAccountsStore } from './app-stores';

// Quiet until usage is high: the figure sits in the sidebar all day, in the row's own colour.
const HEADLINE_CLASS: Record<UsageSeverity, string> = {
  calm: '',
  warning: 'text-foreground-warning',
  critical: 'text-foreground-error',
};

const ClaudeUsageIndicatorButton = observer(function ClaudeUsageIndicatorButton({
  trigger,
}: {
  trigger: ReactElement;
}) {
  useClaudeUsageWatch();
  const store = getClaudeAccountsStore();
  const { navigate } = useNavigate();
  const now = useNow();
  const [open, setOpen] = useState(false);

  const account = store.defaultAccount;
  const headline = headlineUsage(account ? store.usage.get(account.id) : undefined);
  const name = store.hasMultipleAccounts && account ? `Claude: ${account.label}` : 'Claude usage';
  const spoken = headline
    ? `${name}, ${headline.label} usage ${headline.percentLabel}. Show Claude usage`
    : `${name}. Show Claude usage`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} aria-label={spoken} data-active={open || undefined}>
        <span className="flex min-w-0 items-center gap-2">
          <Gauge className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
          <span className="truncate">{name}</span>
        </span>
        {headline ? (
          <span className={cn('shrink-0 text-xs tabular-nums', HEADLINE_CLASS[headline.severity])}>
            {headline.percentLabel}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Content
        side="right"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex items-center justify-between gap-2">
          <Popover.Title>Claude usage</Popover.Title>
          <ClaudeUsageRefresh now={now} />
        </div>
        {/* The side padding leaves room for focus rings inside the scroll area. */}
        <div className="-mx-1 max-h-[min(60vh,28rem)] overflow-y-auto px-1">
          <ClaudeUsagePanel now={now} onBeforeSignIn={() => setOpen(false)} />
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              navigate(settingsViewDef({ tab: 'claude-accounts' }));
            }}
          >
            Manage accounts
          </Button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
});

/**
 * The always-there entry to Claude usage: the account new agents use and how much of its week
 * is spent, opening the usage pane. `trigger` is the host's own button element (the sidebar
 * passes its menu button), so the entry looks like its neighbours. Renders nothing until
 * Claude is in use: a sign-in, or more than one account.
 */
export const ClaudeUsageIndicator = observer(function ClaudeUsageIndicator({
  trigger,
}: {
  trigger: ReactElement;
}) {
  const store = getClaudeAccountsStore();
  if (!store.hasMultipleAccounts && !store.hasAnySignIn) return null;
  return <ClaudeUsageIndicatorButton trigger={trigger} />;
});
