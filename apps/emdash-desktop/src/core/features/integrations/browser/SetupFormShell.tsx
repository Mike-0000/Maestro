import { Button, Dialog, Spinner, useToast } from '@emdash/ui/react/primitives';
import { useState, type ReactNode } from 'react';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import type { IntegrationFormInput } from './types';

export type SetupFormProps = {
  onSuccess: () => void;
  onClose: () => void;
};

type SetupFormShellProps = {
  providerId: string;
  getInput: () => IntegrationFormInput;
  getConnectionOptions?: () => { accountId?: string; displayName?: string };
  reconnect?: boolean;
  canSubmit: boolean;
  onSuccess: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function SetupFormShell({
  providerId,
  getInput,
  getConnectionOptions,
  reconnect = false,
  canSubmit,
  onSuccess,
  onClose,
  children,
}: SetupFormShellProps) {
  const { connectIntegration, isIntegrationMutating } = useIntegrationsContext();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const isMutating = isIntegrationMutating(providerId);

  const handleSubmit = async () => {
    setError(null);

    try {
      const result = await connectIntegration(providerId, getInput(), getConnectionOptions?.());
      if (!result.success) {
        setError(result.error);
        return;
      }

      toast('Integration connected', { description: 'Integration set up successfully.' });
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect.');
    }
  };

  return (
    <>
      <Dialog.Body>
        <div className="pt-1">{children}</div>
        {error ? (
          <p className="text-xs text-foreground-error" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit || isMutating}
        >
          {isMutating && <Spinner size="sm" />}
          {reconnect ? 'Reconnect' : 'Connect'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
}
