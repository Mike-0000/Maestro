import { SettingsSection } from '@emdash/ui/react/patterns';
import { Button, toast } from '@emdash/ui/react/primitives';
import { useEffect, useState } from 'react';
import type { RemoteAccessPairing, RemoteAccessStatus } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import { formatCountdown } from '../remote-access-format';
import { CopyButton } from './copy-button';
import { errorMessage, RemoteAccessRow } from './remote-access-row';

/**
 * Issues a one-time pairing code and shows it until it is used, cancelled or expired. The
 * live status owns the code; the value returned by the issuing call only covers the moment
 * before the status catches up.
 */
export function PairingCard({ status }: { status: RemoteAccessStatus | undefined }) {
  const livePairing = status?.pairing ?? null;
  const [issued, setIssued] = useState<RemoteAccessPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const candidate = livePairing ?? issued;
  useSecondTick(candidate !== null);
  const now = Date.now();
  const pairing = candidate !== null && candidate.expiresAt > now ? candidate : null;
  const issuedExpired = issued !== null && issued.expiresAt <= now;

  useEffect(() => {
    if (livePairing !== null || issuedExpired) setIssued(null);
  }, [livePairing, issuedExpired]);

  const create = async () => {
    setBusy(true);
    try {
      setIssued(await (await getRemoteAccessClient()).createPairingCode(undefined));
    } catch (error) {
      toast.error('Could not create a pairing code', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await (await getRemoteAccessClient()).cancelPairingCode(undefined);
      setIssued(null);
    } catch (error) {
      toast.error('Could not cancel the pairing code', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const listening = status?.listening ?? false;

  return (
    <SettingsSection title="Pair a device">
      {pairing === null ? (
        <RemoteAccessRow
          title="Add your phone or another computer"
          description={
            listening || status === undefined
              ? 'Get a one-time code to enter on the other device. It works once and expires after 10 minutes.'
              : 'Turn on remote access to pair a device.'
          }
          actions={
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!listening || busy}
              onClick={() => void create()}
            >
              Pair a device
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <RemoteAccessRow
            title="Pairing code"
            description={
              <>
                Works once. Expires in{' '}
                <span role="timer" className="text-foreground tabular-nums">
                  {formatCountdown(pairing.expiresAt, now)}
                </span>
                .
              </>
            }
            actions={
              <>
                <CopyButton text={pairing.code} label="pairing code" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  Cancel
                </Button>
              </>
            }
          />
          <output
            aria-label="Pairing code"
            className="block rounded-lg bg-background-1 px-4 py-5 text-center font-mono text-3xl font-semibold tracking-[0.2em] text-foreground select-all"
          >
            {pairing.code}
          </output>
          <ul className="flex flex-col gap-1 text-sm text-foreground-muted">
            <li>
              <span className="text-foreground">On your phone:</span> open the address above and
              enter this code.
            </li>
            <li>
              <span className="text-foreground">In Maestro on another computer:</span> Settings →
              Machines → Add Maestro host.
            </li>
          </ul>
        </div>
      )}
    </SettingsSection>
  );
}

/** Re-renders once a second while `active`, for the countdown. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}
