import { FactGrid, SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { AbsoluteTime, Button, Field, Input, Switch, toast } from '@emdash/ui/react/primitives';
import { useEffect, useState, type FormEvent } from 'react';
import type { RemoteAccessPairing, RemoteAccessStatus } from '@core/features/remote-access/api';
import { getRemoteAccessClient } from '@core/features/remote-access/api/browser/client';
import type {
  RemoteAccessOwnerAccess,
  RemoteAccessOwnerSettingsPatch,
} from '@core/features/remote-access/api/contract';
import {
  clientPlatformLabel,
  formatAllowedLogins,
  formatCountdown,
  parseAllowedLogins,
} from '../remote-access-format';
import { CopyButton } from './copy-button';
import { useSecondTick } from './pairing-card';
import { errorMessage, RemoteAccessRow } from './remote-access-row';

const ENABLED_SWITCH_ID = 'remote-access-owner-enabled';
const TAILSCALE_SWITCH_ID = 'remote-access-owner-tailscale-only';
const LOGINS_INPUT_ID = 'remote-access-owner-logins';
const LOGINS_HINT_ID = 'remote-access-owner-logins-hint';
const LOGINS_ERROR_ID = 'remote-access-owner-logins-error';

type SettingKey = 'enabled' | 'tailscaleOnly';

/**
 * Full access: a Maestro started as a client on another computer drives this app as its own.
 * Off by default, and while it is off the section is one switch and nothing else. Turned on, it
 * shows who may connect, a one-time code to pair a client, and the client attached right now.
 */
export function OwnerAccessCard({ status }: { status: RemoteAccessStatus | undefined }) {
  const owner = status?.ownerAccess;
  // The requested value while `setOwnerAccess` is in flight; the live status takes over after.
  const [pending, setPending] = useState<{ key: SettingKey; value: boolean } | null>(null);

  const apply = async (key: SettingKey, value: boolean, failure: string) => {
    setPending({ key, value });
    try {
      const patch: RemoteAccessOwnerSettingsPatch = { [key]: value };
      const result = await (await getRemoteAccessClient()).setOwnerAccess(patch);
      if (!result.success) toast.error(failure, { description: result.error.message });
    } catch (error) {
      toast.error(failure, { description: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const shown = (key: SettingKey): boolean =>
    pending?.key === key ? pending.value : (owner?.[key] ?? false);
  const enabled = owner?.enabled ?? false;
  const listening = status?.listening ?? false;

  return (
    <SettingsSection
      title="Full access for Maestro clients"
      description="Maestro on another computer, started as a client, drives this app as its own."
    >
      <SettingsRow
        htmlFor={ENABLED_SWITCH_ID}
        label="Allow a full-access client"
        description={
          <span className="flex flex-col gap-1">
            <span role="status" className={enabled ? 'text-foreground' : undefined}>
              {owner === undefined ? 'Checking…' : enabled ? 'On' : 'Off'}
            </span>
            <span>
              A client sees and changes everything this app does: every project, agent and setting.
              One client at a time. While it is connected, this computer&apos;s own Maestro window
              closes, and comes back a minute after the client disconnects.
            </span>
            {enabled && status !== undefined && !listening ? (
              <span className="text-foreground-warning">
                Remote access is not running, so no client can connect. Turn it on above.
              </span>
            ) : null}
          </span>
        }
        control={
          <Switch
            id={ENABLED_SWITCH_ID}
            checked={shown('enabled')}
            disabled={owner === undefined || pending !== null}
            onCheckedChange={(checked) =>
              void apply(
                'enabled',
                checked,
                checked ? 'Could not turn on full access' : 'Could not turn off full access'
              )
            }
          />
        }
      />
      {owner !== undefined && enabled ? (
        <>
          <SettingsRow
            htmlFor={TAILSCALE_SWITCH_ID}
            label="Only over Tailscale"
            description="Accept a client only when it arrives through Tailscale as a signed-in tailnet user, or from this computer itself. Turn this off only for another tunnel you trust, such as Cloudflare Access."
            control={
              <Switch
                id={TAILSCALE_SWITCH_ID}
                checked={shown('tailscaleOnly')}
                disabled={pending !== null}
                onCheckedChange={(checked) =>
                  void apply('tailscaleOnly', checked, 'Could not change the Tailscale setting')
                }
              />
            }
          />
          {owner.tailscaleOnly ? <AllowedLoginsField owner={owner} /> : null}
          <OwnerPairing owner={owner} listening={listening} />
          <AttachedClient owner={owner} />
        </>
      ) : null}
    </SettingsSection>
  );
}

/** The optional allowlist of tailnet logins, applied as a whole like the listener's port. */
function AllowedLoginsField({ owner }: { owner: RemoteAccessOwnerAccess }) {
  const live = formatAllowedLogins(owner.allowedLogins);
  const [text, setText] = useState(live);
  const [editing, setEditing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the live list unless the person is in the middle of changing it.
  useEffect(() => {
    if (!editing) setText(live);
  }, [live, editing]);

  const parsed = parseAllowedLogins(text);
  const unchanged = parsed.ok && formatAllowedLogins(parsed.logins) === live;

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (unchanged) {
      setEditing(false);
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const result = await (
        await getRemoteAccessClient()
      ).setOwnerAccess({ allowedLogins: parsed.logins });
      if (result.success) setEditing(false);
      else setError(result.error.message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void apply(event)}>
      <Field.Root invalid={error !== null}>
        <Field.Label htmlFor={LOGINS_INPUT_ID}>Allowed Tailscale logins</Field.Label>
        <Field.Description id={LOGINS_HINT_ID}>
          Only these tailnet logins may connect as a full-access client, separated by commas. Leave
          it empty to allow everyone in your tailnet.
        </Field.Description>
        <div className="flex items-center gap-2">
          <Input
            id={LOGINS_INPUT_ID}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1"
            placeholder="you@example.com"
            value={text}
            disabled={applying}
            aria-invalid={error !== null}
            aria-describedby={error ? `${LOGINS_HINT_ID} ${LOGINS_ERROR_ID}` : LOGINS_HINT_ID}
            onChange={(event) => {
              setEditing(true);
              setError(null);
              setText(event.target.value);
            }}
            onBlur={() => {
              if (unchanged) setEditing(false);
            }}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={applying || unchanged}>
            Apply
          </Button>
        </div>
        {error ? (
          <p id={LOGINS_ERROR_ID} role="alert" className="text-xs text-foreground-error">
            {error}
          </p>
        ) : null}
      </Field.Root>
    </form>
  );
}

/**
 * Issues a one-time full-access code and shows it until it is used, cancelled or expired. These
 * codes are separate from the ordinary pairing codes above: neither kind works as the other.
 */
function OwnerPairing({
  owner,
  listening,
}: {
  owner: RemoteAccessOwnerAccess;
  listening: boolean;
}) {
  const livePairing = owner.pairing;
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
    const title = 'Could not create a full-access code';
    try {
      const result = await (await getRemoteAccessClient()).createOwnerPairingCode(undefined);
      if (result.success) setIssued(result.data);
      else toast.error(title, { description: result.error.message });
    } catch (error) {
      toast.error(title, { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await (await getRemoteAccessClient()).cancelOwnerPairingCode(undefined);
      setIssued(null);
    } catch (error) {
      toast.error('Could not cancel the full-access code', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  if (pairing === null) {
    return (
      <RemoteAccessRow
        title="Pair a client"
        description={
          listening
            ? 'Get a one-time code to enter in the client. It can only pair a full-access client, never a phone or an ordinary Maestro app.'
            : 'Turn on remote access to pair a client.'
        }
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!listening || busy}
            onClick={() => void create()}
          >
            Create a full-access code
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <RemoteAccessRow
        title="Full-access pairing code"
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
            <CopyButton text={pairing.code} label="full-access code" />
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
      {/* Same treatment as the ordinary code: large mono figures, no box around them. */}
      <output
        aria-label="Full-access pairing code"
        className="block px-4 py-4 text-center font-mono text-2xl font-medium tracking-[0.2em] text-foreground tabular-nums select-all"
      >
        {pairing.code}
      </output>
      <FactGrid labelWidth="12rem">
        <FactGrid.Row label="On the other computer">
          Start Maestro with <code className="font-mono text-xs">--maestro-client</code>.
        </FactGrid.Row>
        <FactGrid.Row label="In the client">
          Enter this computer&apos;s address and this code.
        </FactGrid.Row>
      </FactGrid>
    </div>
  );
}

/** The client driving this app right now. Removing it is done from the paired devices list. */
function AttachedClient({ owner }: { owner: RemoteAccessOwnerAccess }) {
  const client = owner.attachedClient;
  return (
    <RemoteAccessRow
      title="Connected client"
      description={
        client === null ? (
          <span role="status">No client is connected.</span>
        ) : (
          <span role="status" className="flex flex-wrap items-center gap-x-1.5">
            <span className="text-foreground">{client.clientName}</span>
            {client.clientPlatform ? (
              <>
                <span aria-hidden>·</span>
                <span>{clientPlatformLabel(client.clientPlatform)}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>
              Since <AbsoluteTime value={client.since} />
            </span>
          </span>
        )
      }
    />
  );
}
