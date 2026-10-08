import { LogOut, Volume2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { useApp, useRouter, useVoice } from './app-context';
import { ConnectionStatus } from './ConnectionStatus';
import { Button, Switch } from './controls';
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

      <VoiceSettings />

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

/** How this device speaks: settings that stay on the device, not on the host. */
const VoiceSettings = observer(function VoiceSettings() {
  const voice = useVoice();
  return (
    <section aria-labelledby="settings-voice" className="mt-6">
      <h3
        id="settings-voice"
        className="text-fg-muted px-1 pb-1.5 text-[12.5px] font-semibold tracking-wide uppercase"
      >
        Voice
      </h3>
      <div className="border-line bg-canvas overflow-hidden rounded-2xl border">
        <ToggleRow
          id="voice-speak-replies"
          label="Speak replies"
          hint="Read the conductor’s answers aloud on this device."
          checked={!voice.muted}
          onChange={(on) => voice.setMuted(!on)}
        />
        <ToggleRow
          id="voice-speak-attention"
          label="Speak when an agent needs you"
          hint="Says the task’s name when an agent starts waiting for you."
          checked={voice.announceAttention}
          onChange={(on) => voice.setAnnounceAttention(on)}
        />
        <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
          <p className="text-fg-muted min-w-0 text-[13.5px] leading-snug">
            {voice.hud?.speech === 'host'
              ? 'Replies use the voice chosen in Maestro on your computer.'
              : 'Replies use this device’s own voice.'}
          </p>
          <Button
            variant="secondary"
            className="h-9 shrink-0 px-3.5 text-[14px]"
            onClick={() => (voice.speaking ? voice.stopSpeaking() : voice.testVoice())}
          >
            <Volume2 className="size-4" aria-hidden="true" />
            {voice.speaking ? 'Stop' : 'Test voice'}
          </Button>
        </div>
      </div>
    </section>
  );
});

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="border-line flex min-h-12 items-center justify-between gap-4 border-b px-4 py-2.5">
      <div className="min-w-0">
        <p id={id} className="text-[15px]">
          {label}
        </p>
        <p id={`${id}-hint`} className="text-fg-muted mt-0.5 text-[13px] leading-snug">
          {hint}
        </p>
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={id} describedBy={`${id}-hint`} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-line flex min-h-12 items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0">
      <dt className="text-fg-muted shrink-0 text-[14.5px]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[15px]">{children}</dd>
    </div>
  );
}
