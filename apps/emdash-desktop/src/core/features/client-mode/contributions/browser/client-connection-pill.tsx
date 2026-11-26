import { toast } from '@emdash/ui/react/primitives';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { errorMessage, hostLabel } from '../../browser/client-session-format';
import { getClientSessionStore, useClientSession } from '../../browser/client-session-store';
import { ConnectionPill } from '../../browser/connection-pill';

const canCreateShortcut = detectPlatformContext().os === 'windows';

/**
 * The title bar's link to the host. Mount it only when `isClientMode()` is true: it follows the
 * `clientSession` domain, which a local window does not have.
 */
export function ClientConnectionPill() {
  const session = getClientSessionStore();
  const { status } = useClientSession(session);
  const openConfirm = useOpenModal('confirmActionModal');

  if (!status || status.phase === 'unpaired') return null;
  const host = hostLabel(status.host);

  const createShortcut = async () => {
    try {
      const result = await session.createShortcut();
      if (result.success) {
        toast.success('Shortcut created', {
          description: 'On the desktop and in the Start menu. It opens this client directly.',
        });
      } else {
        toast.error('Could not create the shortcut', { description: result.error.message });
      }
    } catch (error) {
      toast.error('Could not create the shortcut', { description: errorMessage(error) });
    }
  };

  const forget = async () => {
    const outcome = await openConfirm({
      title: `Forget ${host}?`,
      description:
        'This client stops connecting to it and restarts. Agents on the host keep running. To use the host again, pair with a new full-access code.',
      confirmLabel: 'Forget',
      variant: 'destructive',
    });
    if (!outcome.success) return;
    try {
      await session.forget();
    } catch (error) {
      toast.error('Could not forget the host', { description: errorMessage(error) });
    }
  };

  const quit = () => {
    session.quit().catch((error: unknown) => {
      toast.error('Could not quit', { description: errorMessage(error) });
    });
  };

  return (
    <ConnectionPill
      status={status}
      canCreateShortcut={canCreateShortcut}
      onCreateShortcut={() => void createShortcut()}
      onQuit={quit}
      onForget={() => void forget()}
    />
  );
}
