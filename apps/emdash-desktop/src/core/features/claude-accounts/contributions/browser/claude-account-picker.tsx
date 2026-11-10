import { Select } from '@emdash/ui/react/primitives';
import { observer, useObserver } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import {
  accountOptionLabel,
  resolveAccountPicker,
  type AccountPickerState,
} from '../../browser/account-model';
import { getClaudeAccountsStore } from './app-stores';

export type ClaudeAccountPicker = AccountPickerState & {
  setValue: (accountId: string) => void;
};

/**
 * The account choice of a form that starts an agent. `visible` is true only for Claude Code on
 * this computer with more than one account; `claudeAccountId` is what to send (undefined leaves
 * the choice to the default account). The picker follows the default until the user picks.
 */
export function useClaudeAccountPicker(
  providerId: string | null | undefined,
  options: { remote: boolean }
): ClaudeAccountPicker {
  const [chosenId, setChosenId] = useState<string | null>(null);
  const state = useObserver(() => getClaudeAccountsStore().state);
  const { remote } = options;
  return useMemo(
    () => ({
      ...resolveAccountPicker({ providerId, remote, state, chosenId }),
      setValue: setChosenId,
    }),
    [providerId, remote, state, chosenId]
  );
}

/**
 * The compact account selector for those forms. `field` fills its column like the model
 * selector in a dialog; `inline` is a small control that sits beside a label.
 */
export const ClaudeAccountSelect = observer(function ClaudeAccountSelect({
  picker,
  variant,
  id,
}: {
  picker: ClaudeAccountPicker;
  variant: 'field' | 'inline';
  id?: string;
}) {
  const store = getClaudeAccountsStore();
  const selected = store.account(picker.value);

  return (
    <Select.Root
      value={picker.value}
      onValueChange={(value) => {
        if (value) picker.setValue(value);
      }}
    >
      <Select.Trigger
        id={id}
        aria-label="Claude account"
        {...(variant === 'field'
          ? { appearance: 'input' as const, className: 'w-full' }
          : { size: 'sm' as const, className: 'max-w-56' })}
      >
        <Select.Value>{selected?.label ?? 'Default account'}</Select.Value>
      </Select.Trigger>
      <Select.Content align="start" width={variant === 'field' ? 'trigger' : undefined}>
        {store.accounts.map((account) => {
          const signedIn = store.isSignedIn(account);
          const label = accountOptionLabel(account, store.defaultAccountId);
          return (
            <Select.Item key={account.id} value={account.id} disabled={!signedIn}>
              {signedIn ? label : `${label} · not signed in`}
            </Select.Item>
          );
        })}
      </Select.Content>
    </Select.Root>
  );
});
