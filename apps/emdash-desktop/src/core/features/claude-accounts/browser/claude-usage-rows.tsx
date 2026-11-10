import { Badge, Button, Spinner, Tooltip, toast } from '@emdash/ui/react/primitives';
import { RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
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
import { useClaudeAccountSignIn } from './use-claude-account-sign-in';

// The app's severity ramp: neutral until usage is high, then warning, then error.
const FILL_CLASS: Record<UsageSeverity, string> = {
  calm: 'bg-foreground-muted',
  warning: 'bg-foreground-warning',
  critical: 'bg-foreground-error',
};

const PERCENT_CLASS: Record<UsageSeverity, string> = {
  calm: 'text-foreground',
  warning: 'text-foreground-warning',
  critical: 'text-foreground-error',
};

/** Keeps usage polled for as long as the calling component is mounted. */
export function useClaudeUsageWatch(): void {
  useEffect(() => getClaudeAccountsStore().watchUsage(), []);
}

function UsageMeterBar({ meter, accountLabel }: { meter: UsageMeter; accountLabel: string }) {
  const resetMoment = formatResetMoment(meter.resetsAt);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="shrink-0 text-foreground-muted">{meter.label}</span>
        <span className="min-w-0 truncate text-foreground-muted">
          <span className={cn('font-medium tabular-nums', PERCENT_CLASS[meter.severity])}>
            {meter.percentLabel}
          </span>
          {meter.resets ? (
            <span title={resetMoment ? `Resets ${resetMoment}` : undefined}>
              {' · '}
              {meter.resets}
            </span>
          ) : null}
        </span>
      </div>
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
    </div>
  );
}

/**
 * One account's usage: name, default marker and plan on the first line, then the weekly and
 * 5-hour meters, the per-model weekly figures in small type, and a note when the numbers are
 * old or missing. The action on the right makes it the account new agents use.
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

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-h-6 items-center gap-2">
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          title={account.email}
        >
          {account.label}
        </span>
        {isDefault && store.hasMultipleAccounts ? (
          <Tooltip.Root>
            <Tooltip.Trigger className="inline-flex shrink-0 items-center leading-none">
              <Badge>Default</Badge>
            </Tooltip.Trigger>
            <Tooltip.Content side="top">New agents use this account.</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        {plan ? <span className="shrink-0 text-xs text-foreground-muted">{plan}</span> : null}
        <span className="flex-1" />
        {view.kind === 'loading' ? null : wantsSignIn || !signedIn ? (
          <Button type="button" variant="secondary" size="xs" onClick={startSignIn}>
            {signedIn ? 'Sign in again' : 'Sign in'}
          </Button>
        ) : !isDefault ? (
          <Button
            type="button"
            variant="secondary"
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
          <div className={cn('flex flex-col gap-2.5', view.stale && 'opacity-70')}>
            {view.meters.map((meter) => (
              <UsageMeterBar key={meter.key} meter={meter} accountLabel={account.label} />
            ))}
          </div>
          {view.models.length > 0 ? (
            <p className="text-xs text-foreground-passive tabular-nums">
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
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-xs text-foreground-muted" aria-live="polite">
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
