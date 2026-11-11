import { Button, Dialog, Field, Input } from '@emdash/ui/react/primitives';
import { ArrowUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { IntegrationProviderDescriptor } from '@core/features/integrations/api/contract';
import { useIntegrationsContext } from '@core/features/integrations/contributions/browser/integrations-provider';
import {
  getIntegrationAuthUi,
  supportsIntegrationReconnect,
} from '@core/manifests/browser/integration-auth-contributions';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { SetupFormShell } from './SetupFormShell';
import type { SetupIntegrationType } from './types';

type IntegrationSetupModalArgs = {
  integration: SetupIntegrationType;
  accountId?: string;
  displayName?: string;
};

type Props = IntegrationSetupModalArgs;

export function IntegrationSetupModal({ integration, accountId, displayName }: Props) {
  const { complete, dismiss } = useModalController('integrationSetupModal');
  const { integrationById } = useIntegrationsContext();
  const metadata = integrationById[integration];
  const authUi = metadata ? getIntegrationAuthUi(metadata) : undefined;
  const AuthUi = authUi?.component;
  const reconnectSupported = !accountId || (metadata && supportsIntegrationReconnect(metadata));

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>
          {metadata
            ? `${accountId ? 'Reconnect' : 'Connect'} ${metadata.name}`
            : 'Connect integration'}
        </Dialog.Title>
      </Dialog.Header>
      {metadata && !reconnectSupported ? (
        <Dialog.Body>
          <p className="text-sm text-foreground-muted">
            This connection method cannot reconnect a selected account.
          </p>
        </Dialog.Body>
      ) : metadata && AuthUi && (!accountId || authUi?.supportsReconnect) ? (
        <AuthUi
          metadata={metadata}
          accountId={accountId}
          displayName={displayName}
          onSuccess={complete}
          onClose={dismiss}
        />
      ) : metadata ? (
        <IntegrationSetupForm
          integration={integration}
          metadata={metadata}
          accountId={accountId}
          displayName={displayName}
          onSuccess={complete}
          onClose={dismiss}
        />
      ) : null}
    </>
  );
}

export const integrationSetupModal = defineModal<void>()({
  id: 'integrationSetupModal',
  component: IntegrationSetupModal,
  size: 'md',
});

function formMethod(metadata: IntegrationProviderDescriptor | undefined) {
  return metadata?.auth.methods.find((method) => method.kind === 'form');
}

function IntegrationSetupForm({
  integration,
  metadata,
  accountId,
  displayName,
  onSuccess,
  onClose,
}: {
  integration: SetupIntegrationType;
  metadata: IntegrationProviderDescriptor;
  accountId?: string;
  displayName?: string;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const method = formMethod(metadata);
  const [accountName, setAccountName] = useState(displayName ?? '');
  const needsAccountName = metadata.auth.accountLabelRequired === true;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((method?.fields ?? []).map((field) => [field.id, field.defaultValue ?? '']))
  );

  const canSubmit = useMemo(
    () =>
      !!method &&
      (!needsAccountName || !!accountName.trim()) &&
      method.fields.every((field) => !field.required || values[field.id]?.trim()),
    [method, values, needsAccountName, accountName]
  );

  if (!method) return null;

  const updateField = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
  };

  return (
    <SetupFormShell
      providerId={integration}
      getInput={() =>
        Object.fromEntries(method.fields.map((field) => [field.id, values[field.id]?.trim() ?? '']))
      }
      getConnectionOptions={() => ({
        accountId,
        ...(needsAccountName ? { displayName: accountName.trim() } : {}),
      })}
      reconnect={accountId !== undefined}
      canSubmit={canSubmit}
      onSuccess={onSuccess}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        {needsAccountName ? (
          <Field.Root className="gap-1.5">
            <Field.Label htmlFor="integration-account-name">Account name</Field.Label>
            <Input
              id="integration-account-name"
              aria-label="Account name"
              placeholder="Your team or workspace"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              autoFocus
              required
            />
            <Field.Description>A name to tell this account apart from others.</Field.Description>
          </Field.Root>
        ) : null}
        {method.fields.map((field, index) => (
          <Field.Root key={field.id} className="gap-1.5">
            <Field.Label htmlFor={`integration-field-${field.id}`}>
              {field.label}
              {field.required ? null : (
                <span className="font-normal text-foreground-passive"> (optional)</span>
              )}
            </Field.Label>
            <Input
              id={`integration-field-${field.id}`}
              type={field.secret ? 'password' : 'text'}
              placeholder={field.placeholder ?? undefined}
              value={values[field.id] ?? ''}
              onChange={(event) => updateField(field.id, event.target.value)}
              className={field.secret ? 'font-mono' : undefined}
              autoComplete="off"
              autoFocus={!needsAccountName && index === 0}
              required={field.required}
            />
          </Field.Root>
        ))}
        {method.help || method.helpUrl ? (
          <p className="text-xs text-foreground-muted">
            {method.help}
            {method.help && method.helpUrl ? ' ' : null}
            {method.helpUrl ? (
              <Button
                variant="text"
                size="xs"
                className="inline-flex gap-0.5 align-baseline"
                aria-label={`Open ${metadata.name} setup guide`}
                onClick={() => window.open(method.helpUrl, '_blank', 'noopener,noreferrer')}
              >
                Setup guide
                <ArrowUpRight className="size-3" aria-hidden />
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>
    </SetupFormShell>
  );
}
