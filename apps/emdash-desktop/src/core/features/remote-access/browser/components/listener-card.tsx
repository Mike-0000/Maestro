import { Pill } from '@emdash/ui/react/components';
import { SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Switch, toast } from '@emdash/ui/react/primitives';
import { useState } from 'react';
import type { RemoteAccessStatus } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { cn } from '@core/primitives/styling/browser/cn';
import { listenerStateLine } from '../remote-access-format';
import { errorMessage } from './remote-access-row';

const SWITCH_ID = 'remote-access-enabled';

/** The main switch, with the listener's state and what it does and does not expose. */
export function ListenerCard({ status }: { status: RemoteAccessStatus | undefined }) {
  // The requested value while `configure` is in flight; the live status takes over after.
  const [pending, setPending] = useState<boolean | null>(null);
  const line = listenerStateLine(status);

  const setEnabled = async (enabled: boolean) => {
    setPending(enabled);
    const title = enabled ? 'Could not turn on remote access' : 'Could not turn off remote access';
    try {
      const result = await (await getRemoteAccessClient()).configure({ enabled });
      if (!result.success) toast.error(title, { description: result.error.message });
    } catch (error) {
      toast.error(title, { description: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsSection>
      <SettingsRow
        htmlFor={SWITCH_ID}
        label={
          <span className="flex items-center gap-2">
            Allow remote access
            {line.tone === 'success' ? (
              <Pill variant="success" dot>
                On
              </Pill>
            ) : line.tone === 'error' ? (
              <Pill variant="error" dot>
                Not running
              </Pill>
            ) : null}
          </span>
        }
        description={
          <span className="flex flex-col gap-1">
            <span
              role="status"
              className={cn(
                'tabular-nums',
                line.tone === 'success' && 'text-foreground',
                line.tone === 'error' && 'text-foreground-destructive'
              )}
            >
              {line.text}
            </span>
            <span>
              The listener only accepts connections from this computer. A private network such as
              Tailscale carries it to your other devices.
            </span>
            {status && !status.webAppAvailable ? (
              <span className="text-foreground-warning">
                This build does not include the web app, so browsers cannot connect. Other Maestro
                apps still can.
              </span>
            ) : null}
          </span>
        }
        control={
          <Switch
            id={SWITCH_ID}
            checked={pending ?? status?.enabled ?? false}
            disabled={status === undefined || pending !== null}
            onCheckedChange={(checked) => void setEnabled(checked)}
          />
        }
      />
    </SettingsSection>
  );
}
