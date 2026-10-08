import { LogOut } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { useApp, useRouter } from './app-context';
import { ConnectionStatus } from './ConnectionStatus';
import { Button } from './controls';
import { Sheet } from './Sheet';

/** About this connection: which computer, which device, how it is doing — and the way out. */
export const SettingsSheet = observer(function SettingsSheet() {
  const app = useApp();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const host = app.overview?.host;

  const signOut = async (): Promise<void> => {
    setBusy(true);
    await app.signOut();
    // The pairing screen replaces everything; drop the sheet's URL with it.
    router.replace({ name: 'home' });
  };

  return (
    <Sheet title="Settings" onClose={() => router.back()}>
      <dl className="border-line bg-canvas overflow-hidden rounded-2xl border">
        <Row label="Computer">{app.hostName}</Row>
        <Row label="This device">{app.session?.device?.name ?? 'Paired browser'}</Row>
        <Row label="Connection">
          <ConnectionStatus className="text-fg text-[15px]" />
        </Row>
        {host?.appVersion ? <Row label="Maestro version">{host.appVersion}</Row> : null}
      </dl>

      <div className="mt-6">
        {confirming ? (
          <div className="border-danger-line bg-danger-soft rounded-2xl border p-4">
            <p className="text-fg text-[14.5px]">
              Sign out of {app.hostName}? This device will need a new pairing code to connect again.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                className="bg-danger flex-1 text-white hover:brightness-110"
                busy={busy}
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" block onClick={() => setConfirming(true)}>
            <LogOut className="size-[18px]" aria-hidden="true" />
            Sign out
          </Button>
        )}
      </div>

      <p className="text-fg-passive mt-5 text-center text-[12.5px] leading-relaxed">
        Agents keep running on your computer when you close this app.
      </p>
    </Sheet>
  );
});

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-line flex min-h-12 items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
      <dt className="text-fg-muted shrink-0 text-[14.5px]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[15px]">{children}</dd>
    </div>
  );
}
