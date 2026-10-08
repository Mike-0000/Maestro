import { BellRing, LogOut, Volume2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import type { PushStatus } from '../state/push-store';
import { useApp, usePush, useRouter, useVoice } from './app-context';
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

      <NotificationSettings />

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

/** Why notifications cannot be turned on here, for the states where they cannot. */
const PUSH_UNAVAILABLE: Partial<Record<PushStatus, string>> = {
  checking: 'Checking…',
  unsupported:
    'This browser cannot receive notifications here. Open Maestro in Chrome through its https address and install it to your home screen.',
  unavailable: 'Your computer cannot store notification keys securely, so notifications are off.',
  unreachable: 'Could not reach your computer.',
  blocked:
    'Notifications are blocked for Maestro on this phone. Allow them in Android settings, then come back.',
};

/** Whether this phone is told when an agent finishes or needs input, even with the app closed. */
const NotificationSettings = observer(function NotificationSettings() {
  const push = usePush();
  useEffect(() => {
    void push.sync();
  }, [push]);

  const unavailable = PUSH_UNAVAILABLE[push.status];
  const on = push.status === 'on';
  return (
    <section aria-labelledby="settings-notifications" className="mt-6">
      <h3
        id="settings-notifications"
        className="text-fg-muted px-1 pb-1.5 text-[12.5px] font-semibold tracking-wide uppercase"
      >
        Notifications
      </h3>
      <div className="border-line bg-canvas overflow-hidden rounded-2xl border">
        {unavailable ? (
          <p className="text-fg-muted px-4 py-3 text-[13.5px] leading-snug">{unavailable}</p>
        ) : (
          <ToggleRow
            id="push-enabled"
            label="Notify this phone"
            hint="Get a notification even when Maestro is closed."
            checked={on}
            onChange={(next) => void (next ? push.enable() : push.disable())}
          />
        )}
        {on ? (
          <>
            <ToggleRow
              id="push-complete"
              label="Agent finished"
              hint="When an agent is done working."
              checked={push.events.complete}
              onChange={(next) => void push.setEvent('complete', next)}
            />
            <ToggleRow
              id="push-attention"
              label="Needs attention"
              hint="When an agent is waiting for you."
              checked={push.events.attention}
              onChange={(next) => void push.setEvent('attention', next)}
            />
            <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
              <p className="text-fg-muted min-w-0 text-[13.5px] leading-snug">
                {push.hostEnabled
                  ? 'Your computer must be on, with Maestro running.'
                  : 'Notifications are turned off in Maestro on your computer.'}
              </p>
              <Button
                variant="secondary"
                className="h-9 shrink-0 px-3.5 text-[14px]"
                busy={push.testing}
                onClick={() => void push.sendTest()}
              >
                <BellRing className="size-4" aria-hidden="true" />
                Send test
              </Button>
            </div>
          </>
        ) : null}
      </div>
      {push.message ? (
        <p
          role="status"
          className={`mt-2 px-1 text-[13px] leading-snug ${
            push.message.tone === 'error' ? 'text-danger' : 'text-fg-muted'
          }`}
        >
          {push.message.text}
        </p>
      ) : null}
    </section>
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
