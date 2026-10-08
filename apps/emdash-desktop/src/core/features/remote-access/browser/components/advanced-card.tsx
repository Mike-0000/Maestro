import { SettingsCard, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Collapsible, Field, Input } from '@emdash/ui/react/primitives';
import { useEffect, useState, type FormEvent } from 'react';
import type { RemoteAccessStatus } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import {
  parsePortInput,
  REMOTE_ACCESS_MAX_PORT,
  REMOTE_ACCESS_MIN_PORT,
} from '../remote-access-format';
import { errorMessage } from './remote-access-row';

const PORT_INPUT_ID = 'remote-access-port';
const PORT_HINT_ID = 'remote-access-port-hint';
const PORT_ERROR_ID = 'remote-access-port-error';

/** Rarely needed listener settings, collapsed by default. */
export function AdvancedCard({ status }: { status: RemoteAccessStatus | undefined }) {
  const livePort = status?.port;
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the live port unless the person is in the middle of changing it.
  useEffect(() => {
    if (!editing && livePort !== undefined) setText(String(livePort));
  }, [livePort, editing]);

  const parsed = parsePortInput(text);
  const unchanged = parsed.ok && parsed.port === livePort;

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (unchanged) return;
    setApplying(true);
    setError(null);
    try {
      const result = await (await getRemoteAccessClient()).configure({ port: parsed.port });
      if (result.success) setEditing(false);
      else setError(result.error.message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <SettingsSection bare>
      <SettingsCard>
        <Collapsible.Root>
          <Collapsible.Trigger>Advanced</Collapsible.Trigger>
          <Collapsible.Panel>
            <form className="flex flex-col gap-2 px-2 pt-3 pb-1" onSubmit={(e) => void apply(e)}>
              <Field.Root invalid={error !== null}>
                <Field.Label htmlFor={PORT_INPUT_ID}>Port</Field.Label>
                <Field.Description id={PORT_HINT_ID}>
                  The local port the listener uses, from {REMOTE_ACCESS_MIN_PORT} to{' '}
                  {REMOTE_ACCESS_MAX_PORT}. Change it if another program already uses this one.
                </Field.Description>
                <div className="flex items-center gap-2">
                  <Input
                    id={PORT_INPUT_ID}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-28 tabular-nums"
                    value={text}
                    disabled={status === undefined || applying}
                    aria-invalid={error !== null}
                    aria-describedby={error ? `${PORT_HINT_ID} ${PORT_ERROR_ID}` : PORT_HINT_ID}
                    onChange={(event) => {
                      setEditing(true);
                      setError(null);
                      setText(event.target.value);
                    }}
                    onBlur={() => {
                      if (unchanged) setEditing(false);
                    }}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    disabled={status === undefined || applying || unchanged}
                  >
                    Apply
                  </Button>
                </div>
                {error ? (
                  <p
                    id={PORT_ERROR_ID}
                    role="alert"
                    className="text-sm text-foreground-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </Field.Root>
            </form>
          </Collapsible.Panel>
        </Collapsible.Root>
      </SettingsCard>
    </SettingsSection>
  );
}
