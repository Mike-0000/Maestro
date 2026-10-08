import { PageLayout } from '@emdash/ui/react/patterns';
import { Alert } from '@emdash/ui/react/primitives';
import { useRemoteAccessStatus } from '@core/features/remote-access/api/browser/use-remote-access-status';
import { AdvancedCard } from '../components/advanced-card';
import { DevicesCard } from '../components/devices-card';
import { ListenerCard } from '../components/listener-card';
import { PairingCard } from '../components/pairing-card';
import { TailscaleCard } from '../components/tailscale-card';
import { TriggersCard } from '../components/triggers-card';

export function RemoteAccessSettingsPage() {
  const { status, isError } = useRemoteAccessStatus();
  // Tailscale forwards to this exact listener, so its state is re-read when either changes.
  const listenerKey = status ? `${status.listening}:${status.port}` : 'unknown';

  return (
    <div className="space-y-8 pb-4">
      <PageLayout.Header
        sticky
        title="Remote access"
        description="Reach this computer's agents from your phone or another computer running Maestro."
      />
      {isError && status === undefined ? (
        <Alert.Root status="destructive">
          <Alert.Title>Remote access is unavailable</Alert.Title>
          <Alert.Description>
            Its status could not be loaded. Restart Maestro and try again.
          </Alert.Description>
        </Alert.Root>
      ) : null}
      <ListenerCard status={status} />
      {status?.enabled ? <TailscaleCard listenerKey={listenerKey} /> : null}
      <PairingCard status={status} />
      <DevicesCard status={status} />
      {status?.enabled ? <TriggersCard status={status} listenerKey={listenerKey} /> : null}
      <AdvancedCard status={status} />
    </div>
  );
}
