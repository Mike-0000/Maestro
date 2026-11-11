import { EmptyState } from '@emdash/ui/react/components';
import { SettingsSection } from '@emdash/ui/react/patterns';
import { AbsoluteTime, Button, RelativeTime, toast } from '@emdash/ui/react/primitives';
import { MonitorIcon, SmartphoneIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteAccessDevice, RemoteAccessStatus } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { deviceActivity, deviceKindLabel, sortDevices } from '../remote-access-format';
import { errorMessage } from './remote-access-row';

/** The devices that hold a pairing, with their activity and a way to remove each. */
export function DevicesCard({ status }: { status: RemoteAccessStatus | undefined }) {
  const openConfirm = useOpenModal('confirmActionModal');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const devices = useMemo(() => (status ? sortDevices(status.devices) : []), [status]);
  useNewDeviceToast(status?.devices);

  const remove = async (device: RemoteAccessDevice) => {
    const outcome = await openConfirm({
      title: `Remove ${device.name}?`,
      description:
        device.connections > 0
          ? 'It is connected right now and will be disconnected. To use it again, pair it with a new code.'
          : 'It will no longer be able to connect. To use it again, pair it with a new code.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!outcome.success) return;
    setRemovingId(device.id);
    try {
      await (await getRemoteAccessClient()).revokeDevice({ deviceId: device.id });
    } catch (error) {
      toast.error('Could not remove the device', { description: errorMessage(error) });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <SettingsSection title="Paired devices">
      {status === undefined ? (
        <EmptyState bare tone="loading" label="Loading devices…" className="py-2" />
      ) : devices.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          No devices yet. Pair one above to reach this computer from it.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center text-foreground-passive">
                {device.kind === 'desktop' ? (
                  <MonitorIcon className="size-4" aria-hidden />
                ) : (
                  <SmartphoneIcon className="size-4" aria-hidden />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-foreground">{device.name}</span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-foreground-muted">
                  <span>{deviceKindLabel(device.kind)}</span>
                  <span aria-hidden>·</span>
                  <DeviceActivityLabel device={device} />
                  <span aria-hidden>·</span>
                  <span>
                    Paired <AbsoluteTime value={device.createdAt} />
                  </span>
                </span>
              </div>
              <Button
                type="button"
                variant="text"
                className="shrink-0"
                disabled={removingId === device.id}
                aria-label={`Remove ${device.name}`}
                onClick={() => void remove(device)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function DeviceActivityLabel({ device }: { device: RemoteAccessDevice }) {
  const activity = deviceActivity(device);
  if (activity.kind === 'connected') {
    // Full-strength words carry "connected"; no green.
    return <span className="text-foreground">Connected now</span>;
  }
  if (activity.kind === 'never') return <span>Never connected</span>;
  return (
    <span>
      Last seen <RelativeTime value={activity.at} />
    </span>
  );
}

/** Confirms a completed pairing: a device that was not in the previous snapshot. */
function useNewDeviceToast(devices: readonly RemoteAccessDevice[] | undefined): void {
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!devices) return;
    const known = knownIds.current;
    if (known) {
      for (const device of devices) {
        if (!known.has(device.id)) toast.success(`${device.name} is paired`);
      }
    }
    knownIds.current = new Set(devices.map((device) => device.id));
  }, [devices]);
}
