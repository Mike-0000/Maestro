import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import type { PushStatus } from '../state/push-store';
import { useApp, usePush, useRouter, useVoice } from './app-context';
import { ConnectionStatus } from './ConnectionStatus';
import { Button, Spinner, Switch, TextAction } from './controls';
import { cx } from './hooks';
import { Sheet } from './Sheet';

/**
 * About this connection: which computer, which device, how it is doing, and the way out. Laid
 * out like the desktop's settings: a title per section over one quiet card of rows, rows set
 * apart by space rather than rules, secondary actions in words.
 */
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
      <div className="flex flex-col gap-8">
        <Section id="settings-connection" title="Connection">
          <dl className="flex flex-col gap-3">
            <Fact label="Computer">{app.hostName}</Fact>
            <Fact label="This device">{app.session?.device?.name ?? 'Paired browser'}</Fact>
            <Fact label="Status">
              <ConnectionStatus />
            </Fact>
            {host?.appVersion ? (
              <Fact label="Maestro version">
                <span className="tabular-nums">{host.appVersion}</span>
              </Fact>
            ) : null}
          </dl>
        </Section>

        <NotificationSettings />

        <VoiceSettings />

        <section aria-label="Sign out">
          {confirming ? (
            <Card>
              <p className="text-body text-foreground">
                Sign out of {app.hostName}? This device will need a new pairing code to connect
                again.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button variant="danger" busy={busy} onClick={() => void signOut()}>
                  Sign out
                </Button>
              </div>
            </Card>
          ) : (
            <div className="flex flex-col items-start">
              <TextAction onClick={() => setConfirming(true)}>Sign out</TextAction>
              <p className="text-detail text-foreground-muted">
                Agents keep running on your computer when you close this app.
              </p>
            </div>
          )}
        </section>
      </div>
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
    <Section id="settings-notifications" title="Notifications">
      {unavailable ? (
        <p className="text-detail flex items-start gap-2 text-foreground-muted">
          {push.status === 'checking' ? (
            <Spinner className="mt-0.5 size-3.5 shrink-0 text-foreground-passive" />
          ) : null}
          {unavailable}
        </p>
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
          <ActionRow
            text={
              push.hostEnabled
                ? 'Your computer must be on, with Maestro running.'
                : 'Notifications are turned off in Maestro on your computer.'
            }
          >
            <TextAction
              className="text-detail"
              disabled={push.testing}
              aria-busy={push.testing || undefined}
              onClick={() => void push.sendTest()}
            >
              {push.testing ? <Spinner className="size-3.5" /> : null}
              Send test
            </TextAction>
          </ActionRow>
        </>
      ) : null}
      {push.message ? (
        <p
          role="status"
          className={cx(
            'text-detail',
            push.message.tone === 'error' ? 'text-foreground-error' : 'text-foreground-muted'
          )}
        >
          {push.message.text}
        </p>
      ) : null}
    </Section>
  );
});

/** How this device speaks: settings that stay on the device, not on the host. */
const VoiceSettings = observer(function VoiceSettings() {
  const voice = useVoice();
  return (
    <Section id="settings-voice" title="Voice">
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
      <ActionRow
        text={
          voice.hud?.speech === 'host'
            ? 'Replies use the voice chosen in Maestro on your computer.'
            : 'Replies use this device’s own voice.'
        }
      >
        <TextAction
          className="text-detail"
          onClick={() => (voice.speaking ? voice.stopSpeaking() : voice.testVoice())}
        >
          {voice.speaking ? 'Stop' : 'Test voice'}
        </TextAction>
      </ActionRow>
    </Section>
  );
});

/** A section title over one quiet card. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="text-body font-semibold text-foreground">
        {title}
      </h3>
      <Card className="mt-3 flex flex-col gap-4">{children}</Card>
    </section>
  );
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx('rounded-lg border border-border-subtle bg-surface-emphasis p-4', className)}
    >
      {children}
    </div>
  );
}

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
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="text-body text-foreground">
          {label}
        </p>
        <p id={`${id}-hint`} className="text-detail mt-0.5 text-foreground-muted">
          {hint}
        </p>
      </div>
      <Switch checked={checked} onChange={onChange} labelledBy={id} describedBy={`${id}-hint`} />
    </div>
  );
}

/** A line of context with its quiet action beside it. */
function ActionRow({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="-my-2 flex items-center justify-between gap-4">
      <p className="text-detail min-w-0 text-foreground-muted">{text}</p>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A label and its value, the desktop's fact row. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-detail shrink-0 text-foreground-muted">{label}</dt>
      <dd className="text-body min-w-0 truncate text-right text-foreground">{children}</dd>
    </div>
  );
}
