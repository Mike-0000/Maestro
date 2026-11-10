import { SeparatedList, Spinner } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { ClaudeUsageRow, useClaudeUsageWatch } from './claude-usage-rows';

/**
 * Usage for every Claude account, one row each, for the popover and the dialog. Keeps usage
 * polled while it is mounted. The settings page lays the same rows out in its own card.
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
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <SeparatedList gap="0.75rem">
      {store.accounts.map((account) => (
        <ClaudeUsageRow
          key={account.id}
          account={account}
          now={now}
          onBeforeSignIn={onBeforeSignIn}
        />
      ))}
    </SeparatedList>
  );
});
