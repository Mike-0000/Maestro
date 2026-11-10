import { Button, Dialog, Field, Input } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { MAX_CLAUDE_ACCOUNT_LABEL_LENGTH, type ClaudeAccount } from '../api/types';
import { getClaudeAccountsStore } from '../contributions/browser/app-stores';
import { accountLabelProblem, claudeAccountsErrorMessage } from './account-model';

type ClaudeAccountLabelModalArgs = {
  /** The account to rename. Omitted when adding a new account. */
  account?: Pick<ClaudeAccount, 'id' | 'label'>;
};

/**
 * Names a Claude account: creates one when adding, renames one otherwise. Completes with the
 * account so the caller can go straight on to signing it in.
 */
export const ClaudeAccountLabelModal = observer(function ClaudeAccountLabelModal({
  account,
}: ClaudeAccountLabelModalArgs) {
  const { complete, dismiss } = useModalController('claudeAccountLabelModal');
  const store = getClaudeAccountsStore();
  const [label, setLabel] = useState(account?.label ?? '');
  const [touched, setTouched] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(isSubmitting);

  const adding = account === undefined;
  const others = store.accounts.filter((candidate) => candidate.id !== account?.id);
  const problem = accountLabelProblem(label, others);
  const unchanged = !adding && label.trim() === account.label;
  const canSubmit = problem === null && !unchanged && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    setTouched(true);
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = adding
        ? await store.create(label.trim())
        : await store.rename(account.id, label.trim());
      if (result.success) {
        complete(result.data);
        return;
      }
      setError(claudeAccountsErrorMessage(result.error));
    } catch {
      setError(adding ? "Couldn't add the account. Try again." : "Couldn't rename the account.");
    }
    setIsSubmitting(false);
  }, [account, adding, canSubmit, complete, label, store]);

  return (
    <>
      <Dialog.Header showCloseButton={false}>
        <Dialog.Title>{adding ? 'Add Claude account' : 'Rename account'}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body className="pt-0">
        <Field.Group>
          <Field.Root>
            <Field.Label>Account name</Field.Label>
            <Input
              value={label}
              maxLength={MAX_CLAUDE_ACCOUNT_LABEL_LENGTH}
              placeholder="Work"
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              autoFocus
            />
            {adding && (
              <Field.Description>
                A name to tell your accounts apart. Next, you sign in to it.
              </Field.Description>
            )}
            {touched && problem && (
              <p className="mt-1 text-xs text-foreground-destructive">{problem}</p>
            )}
            {error && <p className="mt-1 text-xs text-foreground-destructive">{error}</p>}
          </Field.Root>
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={dismiss} disabled={isSubmitting}>
          Cancel
        </Button>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting || unchanged}
        >
          {adding
            ? isSubmitting
              ? 'Adding…'
              : 'Add and sign in'
            : isSubmitting
              ? 'Renaming…'
              : 'Rename'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const claudeAccountLabelModal = defineModal<ClaudeAccount>()({
  id: 'claudeAccountLabelModal',
  component: ClaudeAccountLabelModal,
  size: 'xs',
});
