import { SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Field, Input, SectionLabel, toast } from '@emdash/ui/react/primitives';
import { useState, type FormEvent } from 'react';
import type { RemoteAccessStatus, RemoteAccessTrigger } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { requestsEndpoint } from '../remote-access-format';
import { useRemoteAccessTailscale } from '../use-remote-access-tailscale';
import { CopyButton } from './copy-button';
import { errorMessage, RemoteAccessRow } from './remote-access-row';

const TOKEN_INPUT_ID = 'remote-access-trigger-token';
const NAME_INPUT_ID = 'remote-access-trigger-name';
const AUTOMATION_INPUT_ID = 'remote-access-trigger-automation';
const FORM_HINT_ID = 'remote-access-trigger-hint';
const FORM_ERROR_ID = 'remote-access-trigger-error';
const CODE = 'rounded-xs bg-surface-emphasis px-1 font-mono text-tiny text-foreground';

/**
 * The on-demand agent HTTP API: its bearer token and the trigger names callers may use.
 * A freshly issued token lives only in this component's state, so it is gone once the
 * person dismisses it or leaves the page.
 */
export function TriggersCard({
  status,
  listenerKey,
}: {
  status: RemoteAccessStatus;
  listenerKey: string;
}) {
  const { tailscale } = useRemoteAccessTailscale(listenerKey, true);
  const { tokenSet, routes } = status.triggers;

  return (
    <SettingsSection
      title="Request triggers"
      description="Let another service start agents on this computer over HTTP. Each request runs an on-demand automation and ends as a pull request."
    >
      <TokenRow tokenSet={tokenSet} />
      <TriggerRoutes routes={routes} />
      <p className="text-xs leading-relaxed text-foreground-muted">
        Send{' '}
        <code className={`${CODE} break-all select-all`}>
          POST {requestsEndpoint(status, tailscale)}
        </code>{' '}
        with the header <code className={CODE}>Authorization: Bearer &lt;token&gt;</code>.
      </p>
    </SettingsSection>
  );
}

function TokenRow({ tokenSet }: { tokenSet: boolean }) {
  const openConfirm = useOpenModal('confirmActionModal');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    if (tokenSet) {
      const outcome = await openConfirm({
        title: 'Replace the token?',
        description:
          'Services using the current token will stop working until you give them the new one.',
        confirmLabel: 'Replace token',
        variant: 'destructive',
      });
      if (!outcome.success) return;
    }
    setBusy(true);
    const title = tokenSet ? 'Could not replace the token' : 'Could not generate a token';
    try {
      const result = await (await getRemoteAccessClient()).rotateTriggerToken(undefined);
      if (result.success) setToken(result.data.token);
      else toast.error(title, { description: result.error.message });
    } catch (error) {
      toast.error(title, { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <RemoteAccessRow
        title="Access token"
        description={
          tokenSet
            ? 'A token is set. Callers send it with every request.'
            : 'Callers send this token with every request. Requests are refused until one exists.'
        }
        actions={
          tokenSet ? (
            <Button type="button" variant="text" disabled={busy} onClick={() => void rotate()}>
              Replace token
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void rotate()}
            >
              Generate token
            </Button>
          )
        }
      />
      {token !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              id={TOKEN_INPUT_ID}
              readOnly
              value={token}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton text={token} label="token" />
            <Button type="button" variant="ghost" size="sm" onClick={() => setToken(null)}>
              Done
            </Button>
          </div>
          <label htmlFor={TOKEN_INPUT_ID} role="status" className="text-xs text-foreground-warning">
            Copy this token now. It will not be shown again.
          </label>
        </div>
      ) : null}
    </div>
  );
}

function TriggerRoutes({ routes }: { routes: readonly RemoteAccessTrigger[] }) {
  const [name, setName] = useState('');
  const [automationId, setAutomationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const trimmedName = name.trim();
  const trimmedAutomationId = automationId.trim();

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmedName || !trimmedAutomationId) return;
    setAdding(true);
    setError(null);
    try {
      const result = await (
        await getRemoteAccessClient()
      ).setTrigger({ name: trimmedName, automationId: trimmedAutomationId });
      if (result.success) {
        setName('');
        setAutomationId('');
      } else {
        setError(result.error.message);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (route: RemoteAccessTrigger) => {
    setRemovingName(route.name);
    try {
      await (await getRemoteAccessClient()).removeTrigger({ name: route.name });
    } catch (cause) {
      toast.error('Could not remove the trigger', { description: errorMessage(cause) });
    } finally {
      setRemovingName(null);
    }
  };

  const describedBy = error ? `${FORM_HINT_ID} ${FORM_ERROR_ID}` : FORM_HINT_ID;

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel as="h4">Triggers</SectionLabel>
      {routes.length === 0 ? (
        <p className="text-xs text-foreground-muted">No triggers yet.</p>
      ) : (
        <ul className="flex flex-col">
          {routes.map((route) => (
            <li key={route.name} className="flex min-h-9 items-center gap-3">
              <span className="flex min-w-0 flex-1 items-center gap-2 font-mono text-xs">
                <span className="truncate text-foreground">{route.name}</span>
                <span aria-hidden className="shrink-0 text-foreground-passive">
                  →
                </span>
                <span className="sr-only">runs automation</span>
                <span className="truncate text-foreground-muted">{route.automationId}</span>
              </span>
              <Button
                type="button"
                variant="text"
                className="shrink-0"
                disabled={removingName === route.name}
                aria-label={`Remove trigger ${route.name}`}
                onClick={() => void remove(route)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-col gap-2" onSubmit={(event) => void add(event)}>
        <div className="flex flex-wrap items-end gap-2">
          <Field.Root className="min-w-40 flex-1">
            <Field.Label htmlFor={NAME_INPUT_ID}>Trigger name</Field.Label>
            <Input
              id={NAME_INPUT_ID}
              placeholder="fix-issue"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              value={name}
              disabled={adding}
              aria-invalid={error !== null}
              aria-describedby={describedBy}
              onChange={(event) => {
                setError(null);
                setName(event.target.value);
              }}
            />
          </Field.Root>
          <Field.Root className="min-w-40 flex-1">
            <Field.Label htmlFor={AUTOMATION_INPUT_ID}>Automation id</Field.Label>
            <Input
              id={AUTOMATION_INPUT_ID}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              value={automationId}
              disabled={adding}
              aria-describedby={describedBy}
              onChange={(event) => {
                setError(null);
                setAutomationId(event.target.value);
              }}
            />
          </Field.Root>
          <Button
            type="submit"
            variant="secondary"
            disabled={adding || !trimmedName || !trimmedAutomationId}
          >
            Add
          </Button>
        </div>
        {error ? (
          <p id={FORM_ERROR_ID} role="alert" className="text-xs text-foreground-error">
            {error}
          </p>
        ) : null}
        <p id={FORM_HINT_ID} className="text-xs text-foreground-muted">
          The automation id is shown under Trigger on an automation with On demand turned on.
        </p>
      </form>
    </div>
  );
}
