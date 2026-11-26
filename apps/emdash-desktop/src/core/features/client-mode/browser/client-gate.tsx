import { EmptyState } from '@emdash/ui/react/components';
import { Button, Tooltip } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';
import { ChorusMark } from '@core/primitives/app-identity/browser/chorus-logo';
import type { ClientSessionStatus } from '../api/client-session-contract';
import { BlockedPanel } from './blocked-panel';
import { attemptLabel, errorMessage, hostAddressLabel, hostLabel } from './client-session-format';
import { useClientSession, type ClientSession } from './client-session-store';
import type { ClientUpdatesPort } from './client-update';
import { PairingForm } from './pairing-form';
import { ForgetHostAction, QuitAction, StatePanel, useSessionAction } from './state-panel';

export type ClientGateProps = {
  session: ClientSession;
  /** Window controls for a frameless window; the host shell supplies them. */
  windowChrome?: ReactNode;
  /** Tests only: the client's own updater. */
  getUpdatesClient?: () => Promise<ClientUpdatesPort>;
};

/**
 * What a client window shows until its link to the host is attached: pairing, connecting, or the
 * reason the host refused. One centred column on the plain content surface under the app's mark,
 * like first-run setup, so it reads as part of Maestro and not as an error page.
 */
export function ClientGate({ session, windowChrome, getUpdatesClient }: ClientGateProps) {
  const { status, loadError } = useClientSession(session);
  const linking = status?.phase === 'connecting' || status?.phase === 'reconnecting';

  return (
    <Tooltip.Provider delay={400}>
      <div
        data-client-gate={status?.phase ?? (loadError !== undefined ? 'error' : 'loading')}
        className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-background px-6 text-foreground [-webkit-app-region:drag]"
      >
        {windowChrome}
        <main className="my-auto flex w-full max-w-lg flex-col items-center py-16 [-webkit-app-region:no-drag]">
          <ChorusMark size={40} animated={linking} />
          <div
            // A new screen fades in; a status tick inside the same screen does not.
            key={screenKey(status, loadError)}
            className="mt-10 flex w-full flex-col items-center motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
          >
            <GateScreen
              session={session}
              status={status}
              loadError={loadError}
              getUpdatesClient={getUpdatesClient}
            />
          </div>
        </main>
      </div>
    </Tooltip.Provider>
  );
}

function screenKey(status: ClientSessionStatus | undefined, loadError: unknown): string {
  if (!status) return loadError !== undefined ? 'error' : 'loading';
  if (status.phase === 'blocked') return `blocked:${status.blocked?.reason ?? 'unknown'}`;
  // Connecting and reconnecting are one screen with different words.
  return status.phase === 'reconnecting' ? 'connecting' : status.phase;
}

function GateScreen({
  session,
  status,
  loadError,
  getUpdatesClient,
}: {
  session: ClientSession;
  status: ClientSessionStatus | undefined;
  loadError: unknown;
  getUpdatesClient?: () => Promise<ClientUpdatesPort>;
}) {
  if (!status) {
    if (loadError === undefined) {
      return <EmptyState bare tone="loading" label="Starting the client…" />;
    }
    return (
      <EmptyState
        bare
        tone="error"
        label="This client could not start"
        description="It could not read its own connection state. Restart it; if that does not help, start Maestro the usual way and check the client's log."
        details={errorMessage(loadError)}
        action={
          <Button
            type="button"
            variant="text"
            onClick={() => void session.relaunch().catch(() => window.location.reload())}
          >
            Restart the client
          </Button>
        }
      />
    );
  }

  switch (status.phase) {
    case 'unpaired':
      return (
        <StatePanel
          variant="page"
          title="Connect to a Maestro host"
          description="This window drives Maestro on another computer: its projects, agents and settings. Enter that computer's address and a full-access pairing code from it."
        >
          <PairingForm session={session} />
        </StatePanel>
      );
    case 'connecting':
    case 'reconnecting':
      return <LinkingScreen session={session} status={status} />;
    case 'blocked':
      return (
        <BlockedPanel
          session={session}
          status={status}
          variant="page"
          getUpdatesClient={getUpdatesClient}
        />
      );
    case 'connected':
      return (
        <StatePanel
          variant="page"
          title={`Connected to ${hostLabel(status.host)}`}
          description="Loading your workspace…"
        />
      );
  }
}

/** Dialing the host: what is being reached, how it is going, and the way out if it never works. */
function LinkingScreen({
  session,
  status,
}: {
  session: ClientSession;
  status: ClientSessionStatus;
}) {
  const action = useSessionAction();
  const host = hostLabel(status.host);
  const address = status.host ? hostAddressLabel(status.host.url) : null;
  const attempt = attemptLabel(status.attempt);
  const struggling = attempt !== null || status.lastError !== null;

  return (
    <StatePanel
      variant="page"
      title={
        <span role="status">
          {status.phase === 'reconnecting' ? 'Reconnecting' : 'Connecting'} to {host}…
        </span>
      }
      description={
        struggling
          ? 'The host is not answering yet. This client keeps trying; your agents on the host are not affected.'
          : address && address !== host
            ? address
            : undefined
      }
      error={action.error}
      secondary={
        <>
          <Button
            type="button"
            variant="text"
            disabled={action.pending !== null}
            onClick={() => action.run('retry', () => session.retryNow())}
          >
            Retry now
          </Button>
          <ForgetHostAction session={session} hostName={host} />
          <QuitAction session={session} />
        </>
      }
    >
      {struggling ? <AttemptLine attempt={attempt} lastError={status.lastError} /> : null}
    </StatePanel>
  );
}

/** How the retries are going, in the caption role: the count, then the last thing that failed. */
export function AttemptLine({
  attempt,
  lastError,
  className,
}: {
  attempt: string | null;
  lastError: string | null;
  className?: string;
}) {
  if (attempt === null && lastError === null) return null;
  return (
    <p className={className ?? 'mx-auto max-w-sm text-xs break-words text-foreground-muted'}>
      {attempt ? <span className="text-foreground tabular-nums">{attempt}</span> : null}
      {attempt && lastError ? <span aria-hidden> · </span> : null}
      {lastError ? <span>{lastError}</span> : null}
    </p>
  );
}
