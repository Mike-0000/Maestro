import { Button, Spinner, Tooltip, toast } from '@emdash/ui/react/primitives';
import { RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ClaudeAccount } from '../api/types';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { claudeAccountsErrorMessage } from './account-model';
import {
  formatResetMoment,
  formatUpdatedAgo,
  usagePlanLabel,
  usageRowView,
  type UsageMeter,
  type UsageSeverity,
} from './usage-model';
import { USAGE_TEXT_CLASS } from './usage-tone';
import { useClaudeAccountSignIn } from './use-claude-account-sign-in';

// Quiet until usage is high: the bar and figure stay neutral, then take the warning colour near
// the limit and the error colour at it (text and fill only, never a tinted panel).
const FILL_CLASS: Record<UsageSeverity, string> = {
  calm: 'bg-foreground-muted',
  warning: 'bg-foreground-warning',
  critical: 'bg-foreground-error',
};

/** The 5-hour window first (it runs out within a working session), then the week. */
const METER_ORDER: Record<UsageMeter['key'], number> = { 'five-hour': 0, weekly: 1 };

/** Keeps usage polled for as long as the calling component is mounted. */
export function useClaudeUsageWatch(): void {
  useEffect(() => getClaudeAccountsStore().watchUsage(), []);
}

/**
 * One window on one line of the meters grid: its name, the bar, the figure, and when it resets
 * (the exact moment in a tooltip). The grid's columns line the bars and figures up.
 */
function UsageMeterLine({ meter, accountLabel }: { meter: UsageMeter; accountLabel: string }) {
  const resetMoment = formatResetMoment(meter.resetsAt);
  return (
    <Fragment>
      <span className="text-xs text-foreground-muted">{meter.label}</span>
      <div
        role="progressbar"
        aria-label={`${accountLabel}: ${meter.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meter.percent)}
        aria-valuetext={`${meter.percentLabel} used${meter.resets ? `, ${meter.resets}` : ''}`}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
            meter.percent > 0 && 'min-w-1',
            FILL_CLASS[meter.severity]
          )}
          style={{ width: `${meter.percent}%` }}
        />
      </div>
      <span
        className={cn(
          'text-right text-xs font-medium tabular-nums',
          USAGE_TEXT_CLASS[meter.severity]
        )}
      >
        {meter.percentLabel}
      </span>
      <span
        className="truncate text-xs text-foreground-passive tabular-nums"
        title={resetMoment ? `Resets ${resetMoment}` : undefined}
      >
        {meter.resets ?? ''}
      </span>
    </Fragment>
  );
}

/**
 * One account's usage: its name, plan and whether new agents use it on the first line, then the
 * 5-hour and weekly meters as bars with their figures and reset times, the per-model weekly
 * figures in the caption role, and a note when the numbers are old or missing. The text action
 * on the right signs it in or makes it the account new agents use.
 */
export const ClaudeUsageRow = observer(function ClaudeUsageRow({
  account,
  now,
  onBeforeSignIn,
}: {
  account: ClaudeAccount;
  now: number;
  /** Lets a popover close itself before the sign-in dialog opens over it. */
  onBeforeSignIn?: () => void;
}) {
  const store = getClaudeAccountsStore();
  const signIn = useClaudeAccountSignIn();
  const [switching, setSwitching] = useState(false);
  const usage = store.usage.get(account.id);
  const view = usageRowView(usage, now);
  const plan = usagePlanLabel(usage, account);
  const isDefault = account.id === store.defaultAccountId;
  const signedIn = store.isSignedIn(account);

  const startSignIn = () => {
    onBeforeSignIn?.();
    void signIn(account);
  };

  const makeDefault = async () => {
    setSwitching(true);
    try {
      const result = await store.setDefault(account.id);
      if (result.success) toast(`New agents now use ${account.label}`);
      else {
        toast.error("Couldn't switch account", {
          description: claudeAccountsErrorMessage(result.error),
        });
      }
    } catch {
      toast.error("Couldn't switch account");
    } finally {
      setSwitching(false);
    }
  };

  const wantsSignIn =
    (view.kind === 'unavailable' && view.action === 'sign-in') ||
    (view.kind === 'meters' && view.stale?.action === 'sign-in');

  const facts = [plan, isDefault && store.hasMultipleAccounts ? 'Used by new agents' : null].filter(
    (fact): fact is string => Boolean(fact)
  );

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-6 items-baseline gap-2">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={account.email}
        >
          {account.label}
        </span>
        {facts.length > 0 ? (
          <span className="min-w-0 truncate text-xs text-foreground-muted">
            {facts.join(' · ')}
          </span>
        ) : null}
        <span className="flex-1" />
        {view.kind === 'loading' ? null : wantsSignIn || !signedIn ? (
          <Button type="button" variant="text" size="xs" onClick={startSignIn}>
            {signedIn ? 'Sign in again' : 'Sign in'}
          </Button>
        ) : !isDefault ? (
          <Button
            type="button"
            variant="text"
            size="xs"
            disabled={switching}
            onClick={() => void makeDefault()}
          >
            Use for new agents
          </Button>
        ) : null}
      </div>

      {view.kind === 'loading' ? (
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <Spinner size="sm" />
          Loading usage…
        </div>
      ) : view.kind === 'unavailable' ? (
        <p className="text-xs text-foreground-muted">{view.message}</p>
      ) : (
        <>
          <div
            className={cn(
              'grid grid-cols-[auto_minmax(3rem,1fr)_auto_minmax(0,auto)] items-center gap-x-3 gap-y-2',
              view.stale && 'opacity-70'
            )}
          >
            {[...view.meters]
              .sort((a, b) => METER_ORDER[a.key] - METER_ORDER[b.key])
              .map((meter) => (
                <UsageMeterLine key={meter.key} meter={meter} accountLabel={account.label} />
              ))}
          </div>
          {view.models.length > 0 ? (
            <p className="text-tiny text-foreground-passive tabular-nums">
              Weekly by model:{' '}
              {view.models.map((model) => `${model.label} ${model.percentLabel}`).join(' · ')}
            </p>
          ) : null}
          {view.stale ? (
            <p className="text-xs text-foreground-muted">
              As of {view.stale.asOf}. {view.stale.note}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
});

/** When usage was last checked, and the control that checks it again now. */
export const ClaudeUsageRefresh = observer(function ClaudeUsageRefresh({
  now,
  className,
}: {
  now: number;
  className?: string;
}) {
  const store = getClaudeAccountsStore();
  const updated = formatUpdatedAgo(store.usageCheckedAt, now);
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <span className="text-xs text-foreground-passive tabular-nums" aria-live="polite">
        {store.usageLoading ? 'Checking…' : updated}
      </span>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon
              disabled={store.usageLoading}
              onClick={() => void store.refreshUsage({ force: true })}
              aria-label="Refresh usage"
            >
              <RefreshCw
                className={cn(store.usageLoading && 'animate-spin motion-reduce:animate-none')}
              />
            </Button>
          }
        />
        <Tooltip.Content side="top">Refresh usage</Tooltip.Content>
      </Tooltip.Root>
    </div>
  );
});
