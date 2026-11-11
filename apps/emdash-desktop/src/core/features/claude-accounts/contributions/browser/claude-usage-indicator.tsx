import { Button, Popover } from '@emdash/ui/react/primitives';
import { Gauge } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useState, type ReactElement } from 'react';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { ClaudeUsagePanel } from '../../browser/claude-usage-panel';
import { ClaudeUsageRefresh, useClaudeUsageWatch } from '../../browser/claude-usage-rows';
import { compactUsage } from '../../browser/usage-model';
import { USAGE_CAPTION_CLASS } from '../../browser/usage-tone';
import { useNow } from '../../browser/use-now';
import { getClaudeAccountsStore } from './app-stores';

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

  // The account new agents use, and both of its windows: quiet caption figures that only take
  // the warning colour near a limit (the row sits in the sidebar all day).
  const account = store.defaultAccount;
  const figures = compactUsage(account ? store.usage.get(account.id) : undefined);
  const name = store.hasMultipleAccounts && account ? `Claude · ${account.label}` : 'Claude usage';
  const spokenName =
    store.hasMultipleAccounts && account ? `Claude, ${account.label} account` : 'Claude usage';
  const spoken =
    figures.length > 0
      ? `${spokenName}: ${figures.map((f) => `${f.label} ${f.percentLabel} used`).join(', ')}. Show Claude usage`
      : `${spokenName}. Show Claude usage`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} aria-label={spoken} data-active={open || undefined}>
        <span className="flex min-w-0 items-center gap-2">
          <Gauge className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </span>
        {figures.length > 0 ? (
          <span className="flex shrink-0 items-baseline gap-1.5 text-tiny tabular-nums">
            {figures.map((figure, index) => (
              <Fragment key={figure.key}>
                {index > 0 ? (
                  <span aria-hidden className="text-foreground-passive">
                    ·
                  </span>
                ) : null}
                <span className={USAGE_CAPTION_CLASS[figure.severity]}>
                  {figure.short} {figure.percentLabel}
                </span>
              </Fragment>
            ))}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Content
        side="right"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)] gap-4"
      >
        <div className="flex items-center justify-between gap-3">
          <Popover.Title>Claude usage</Popover.Title>
          <ClaudeUsageRefresh now={now} className="-mr-1.5" />
        </div>
        {/* The side padding leaves room for focus rings inside the scroll area. */}
        <div className="-mx-1 max-h-[min(60vh,28rem)] overflow-y-auto px-1">
          <ClaudeUsagePanel now={now} onBeforeSignIn={() => setOpen(false)} />
        </div>
        <div className="flex">
          <Button
            type="button"
            variant="text"
            size="sm"
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
 * The always-there entry to Claude usage: the account new agents use and how much of its
 * 5-hour and weekly windows is spent, opening the usage pane. `trigger` is the host's own button
 * element (the sidebar passes its menu button), so the entry looks like its neighbours. Renders
 * nothing until Claude is in use: a sign-in, or more than one account.
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
