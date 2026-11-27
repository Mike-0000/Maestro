import { PageLayout } from '@emdash/ui/react/patterns';
import { Alert } from '@emdash/ui/react/primitives';
import { ClientProfilesCard } from '@core/features/client-profiles/contributions/browser/client-profiles-card';
import { useRemoteAccessStatus } from '@core/features/remote-access/api/browser/use-remote-access-status';
import { isClientMode } from '@core/primitives/client-mode/browser/client-mode';
import { AdvancedCard } from '../components/advanced-card';
import { DevicesCard } from '../components/devices-card';
import { ListenerCard } from '../components/listener-card';
import { OwnerAccessCard } from '../components/owner-access-card';
import { PairingCard } from '../components/pairing-card';
import { TailscaleCard } from '../components/tailscale-card';
import { TriggersCard } from '../components/triggers-card';

export function RemoteAccessSettingsPage() {
  const { status, isError } = useRemoteAccessStatus();
  // Tailscale forwards to this exact listener, so its state is re-read when either changes.
  const listenerKey = status ? `${status.listening}:${status.port}` : 'unknown';

  return (
    <div className="pb-16">
      <PageLayout.Header
        sticky
        title="Remote access"
        description="Reach this computer's agents from your phone or another computer running Maestro."
      />
      <div className="flex flex-col gap-10">
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
        <OwnerAccessCard status={status} />
        {status?.enabled ? <TriggersCard status={status} listenerKey={listenerKey} /> : null}
        {/* Client profiles belong to this computer; a client window shows the host's page. */}
        {isClientMode() ? null : <ClientProfilesCard />}
        <AdvancedCard status={status} />
      </div>
    </div>
  );
}
