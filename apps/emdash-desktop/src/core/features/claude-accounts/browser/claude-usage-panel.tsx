import { Spinner } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { ClaudeUsageRow, useClaudeUsageWatch } from './claude-usage-rows';

/**
 * Usage for every Claude account, one block each separated by space, for the popover and the
 * dialog. Keeps usage polled while it is mounted. The settings page lays the same rows out in
 * its own card.
 */
export const ClaudeUsagePanel = observer(function ClaudeUsagePanel({
  now,
  onBeforeSignIn,
}: {
  now: number;
  /** Lets a popover close itself before the sign-in dialog opens over it. */
  onBeforeSignIn?: () => void;
}) {
  useClaudeUsageWatch();
  const store = getClaudeAccountsStore();

  if (!store.state) {
    return (
      <div
        role="status"
        className="flex items-center justify-center gap-2 py-6 text-xs text-foreground-muted"
      >
        <Spinner size="sm" />
        Loading accounts…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {store.accounts.map((account) => (
        <ClaudeUsageRow
          key={account.id}
          account={account}
          now={now}
          onBeforeSignIn={onBeforeSignIn}
        />
      ))}
    </div>
  );
});
