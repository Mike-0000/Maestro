import { FactGrid } from '@emdash/ui/react/patterns';
import { Button, Spinner } from '@emdash/ui/react/primitives';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ClientSessionStatus } from '../api/client-session-contract';
import {
  blockedCopy,
  buildLabel,
  errorMessage,
  hostLabel,
  hostUpdateErrorHint,
  olderSide,
} from './client-session-format';
import type { ClientSession } from './client-session-store';
import { clientUpdateLine, useClientUpdate, type ClientUpdatesPort } from './client-update';
import { PairingForm } from './pairing-form';
import {
  ForgetHostAction,
  QuitAction,
  StatePanel,
  useSessionAction,
  type PanelVariant,
} from './state-panel';

/** After the host agreed to update, look for it again this often. */
export const HOST_UPDATE_RECHECK_MS = 10_000;

export type BlockedPanelProps = {
  session: ClientSession;
  status: ClientSessionStatus;
  variant: PanelVariant;
  titleId?: string;
  descriptionId?: string;
  /** Tests only: the client's own updater. */
  getUpdatesClient?: () => Promise<ClientUpdatesPort>;
};

/**
 * A link the host refused, one screen per reason. Each names what happened, what to do, and puts
 * the move that fixes it first; quitting and forgetting the host are always within reach.
 */
export function BlockedPanel(props: BlockedPanelProps) {
  const reason = props.status.blocked?.reason;
  if (reason === 'build-mismatch') return <BuildMismatchPanel {...props} />;
  if (reason === 'revoked') return <RevokedPanel {...props} />;
  return <RetryablePanel {...props} />;
}

function PendingLabel({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <>
      {pending ? <Spinner size="sm" /> : null}
      {children}
    </>
  );
}

/** Reasons fixed somewhere else (the host's settings, another client, the network). */
function RetryablePanel({ session, status, variant, titleId, descriptionId }: BlockedPanelProps) {
  const reason = status.blocked?.reason;
  const copy = blockedCopy(status);
  const action = useSessionAction();
  const host = hostLabel(status.host);
  const takesOver = reason === 'busy' || reason === 'superseded';
  const busy = action.pending !== null;

  const retry = (
    <Button
      type="button"
      variant={takesOver ? 'text' : 'primary'}
      className={!takesOver && variant === 'page' ? 'min-w-40' : undefined}
      disabled={busy}
      onClick={() => action.run('retry', () => session.retryNow())}
    >
      <PendingLabel pending={!takesOver && action.pending === 'retry'}>Try again</PendingLabel>
    </Button>
  );

  return (
    <StatePanel
      variant={variant}
      titleId={titleId}
      descriptionId={descriptionId}
      title={copy.title}
      description={copy.description}
      detail={status.blocked?.detail}
      error={action.error}
      primary={
        takesOver ? (
          <Button
            type="button"
            variant="primary"
            className={variant === 'page' ? 'min-w-40' : undefined}
            disabled={busy}
            onClick={() => action.run('takeover', () => session.takeOver())}
          >
            <PendingLabel pending={action.pending === 'takeover'}>
              {reason === 'superseded' ? 'Reconnect here' : 'Take over'}
            </PendingLabel>
          </Button>
        ) : (
          retry
        )
      }
      secondary={
        <>
          {reason === 'busy' ? retry : null}
          {reason === 'busy' || reason === 'superseded' ? null : (
            <ForgetHostAction session={session} hostName={host} disabled={busy} />
          )}
          <QuitAction session={session} disabled={busy} />
        </>
      }
    />
  );
}

/** The pairing was removed on the host: the way back is a new code, entered right here. */
function RevokedPanel({ session, status, variant, titleId, descriptionId }: BlockedPanelProps) {
  const copy = blockedCopy(status);
  return (
    <StatePanel
      variant={variant}
      titleId={titleId}
      descriptionId={descriptionId}
      title={copy.title}
      description={copy.description}
      detail={status.blocked?.detail}
      secondary={
        <>
          <ForgetHostAction session={session} hostName={hostLabel(status.host)} />
          <QuitAction session={session} />
        </>
      }
    >
      <PairingForm session={session} initialUrl={status.host?.url ?? ''} submitLabel="Pair again" />
    </StatePanel>
  );
}

type HostUpdate =
  | { status: 'idle' }
  | { status: 'requesting'; when: 'idle' | 'now' }
  | { status: 'requested'; when: 'idle' | 'now' }
  | { status: 'failed'; message: string; hint: string | null };

/**
 * Client and host run different builds. Both builds are named, the side that is behind gets the
 * primary button when the version numbers tell, and either side can be updated from here.
 */
function BuildMismatchPanel({
  session,
  status,
  variant,
  titleId,
  descriptionId,
  getUpdatesClient,
}: BlockedPanelProps) {
  const copy = blockedCopy(status);
  const host = hostLabel(status.host);
  const clientBuild = status.blocked?.clientBuild;
  const hostBuild = status.blocked?.hostBuild;
  const older = olderSide(clientBuild, hostBuild);
  const action = useSessionAction();
  const clientUpdate = useClientUpdate(getUpdatesClient);
  const [hostUpdate, setHostUpdate] = useState<HostUpdate>({ status: 'idle' });

  // Once the host has agreed to update, keep looking for it: it restarts on its own schedule.
  const waitingForHost = hostUpdate.status === 'requested';
  useEffect(() => {
    if (!waitingForHost) return;
    const timer = setInterval(
      () => void session.retryNow().catch(() => {}),
      HOST_UPDATE_RECHECK_MS
    );
    return () => clearInterval(timer);
  }, [waitingForHost, session]);

  const requestHostUpdate = async (when: 'idle' | 'now') => {
    setHostUpdate({ status: 'requesting', when });
    try {
      const result = await session.requestHostUpdate(when);
      setHostUpdate(
        result.success
          ? { status: 'requested', when }
          : {
              status: 'failed',
              message: result.error.message,
              hint: hostUpdateErrorHint(result.error.type),
            }
      );
    } catch (error) {
      setHostUpdate({ status: 'failed', message: errorMessage(error), hint: null });
    }
  };

  const clientState = clientUpdate.state;
  const clientBusy =
    clientState.status === 'checking' ||
    clientState.status === 'downloading' ||
    clientState.status === 'installing';
  const hostBusy = hostUpdate.status === 'requesting';
  const clientLine = clientUpdateLine(clientState);

  const updateHostButton = (
    <Button
      type="button"
      variant={older === 'host' ? 'primary' : 'secondary'}
      disabled={hostBusy || hostUpdate.status === 'requested'}
      onClick={() => void requestHostUpdate('idle')}
    >
      <PendingLabel pending={hostBusy}>Update host</PendingLabel>
    </Button>
  );
  const updateClientButton =
    clientState.status === 'ready' ? (
      <Button type="button" variant="primary" onClick={clientUpdate.install}>
        Restart to update
      </Button>
    ) : (
      <Button
        type="button"
        variant={older === 'client' ? 'primary' : 'secondary'}
        disabled={clientBusy || clientState.status === 'current'}
        onClick={clientUpdate.start}
      >
        <PendingLabel pending={clientBusy}>Update this client</PendingLabel>
      </Button>
    );

  return (
    <StatePanel
      variant={variant}
      titleId={titleId}
      descriptionId={descriptionId}
      title={copy.title}
      description={copy.description}
      detail={status.blocked?.detail}
      error={action.error}
      primary={
        // The primary button, when there is one, sits last in the row.
        older === 'client' ? (
          <>
            {updateHostButton}
            {updateClientButton}
          </>
        ) : (
          <>
            {updateClientButton}
            {updateHostButton}
          </>
        )
      }
      secondary={
        <>
          <Button
            type="button"
            variant="text"
            disabled={action.pending !== null}
            onClick={() => action.run('retry', () => session.retryNow())}
          >
            Check again
          </Button>
          <ForgetHostAction session={session} hostName={host} />
          <QuitAction session={session} />
        </>
      }
    >
      <div
        className={cn(
          'flex w-full flex-col gap-3 text-left',
          variant === 'page' && 'mx-auto max-w-sm'
        )}
      >
        <div className="rounded-lg border border-border-subtle bg-surface-emphasis px-4 py-3">
          <FactGrid labelWidth="7.5rem" stackBelow="never">
            <FactGrid.Row label="This client">
              <BuildValue label={buildLabel(clientBuild)} behind={older === 'client'} />
            </FactGrid.Row>
            <FactGrid.Row label={host}>
              <BuildValue label={buildLabel(hostBuild)} behind={older === 'host'} />
            </FactGrid.Row>
          </FactGrid>
        </div>
        {clientLine ? (
          <p
            role="status"
            className={
              clientState.status === 'failed'
                ? 'text-xs text-foreground-error'
                : 'text-xs text-foreground-muted tabular-nums'
            }
          >
            {clientLine}
          </p>
        ) : null}
        {hostUpdate.status === 'requested' ? (
          <p role="status" className="text-xs text-foreground-muted">
            {hostUpdate.when === 'idle'
              ? `${host} will update as soon as none of its agents are working. This client connects by itself when it is back.`
              : `${host} is updating now. This client connects by itself when it is back.`}{' '}
            {hostUpdate.when === 'idle' ? (
              <Button
                type="button"
                variant="text"
                size="xs"
                onClick={() => void requestHostUpdate('now')}
              >
                Update now, stopping its agents
              </Button>
            ) : null}
          </p>
        ) : null}
        {hostUpdate.status === 'failed' ? (
          <p role="alert" className="text-xs text-foreground-error">
            {hostUpdate.message}
            {hostUpdate.hint ? (
              <span className="mt-1 block text-foreground-muted">{hostUpdate.hint}</span>
            ) : null}
          </p>
        ) : null}
        {clientBuild?.dev ? (
          <p className="text-tiny text-foreground-passive">
            Development builds can skip this check: start the client with
            MAESTRO_SKIP_BUILD_CHECK=1.
          </p>
        ) : null}
      </div>
    </StatePanel>
  );
}

function BuildValue({ label, behind }: { label: string; behind: boolean }) {
  return (
    <span className="font-mono text-xs tabular-nums">
      {label}
      {behind ? <span className="font-sans text-foreground-muted"> · behind</span> : null}
    </span>
  );
}
