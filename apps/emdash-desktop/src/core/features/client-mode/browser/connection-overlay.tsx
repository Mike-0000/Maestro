import { Button, Spinner } from '@emdash/ui/react/primitives';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ClientSessionStatus } from '../api/client-session-contract';
import { BlockedPanel } from './blocked-panel';
import { AttemptLine } from './client-gate';
import { attemptLabel, hostLabel, RECONNECT_GRACE_MS } from './client-session-format';
import {
  getClientSessionStore,
  useClientSession,
  type ClientSession,
} from './client-session-store';
import type { ClientUpdatesPort } from './client-update';
import { QuitAction, StatePanel, useSessionAction } from './state-panel';

export type ConnectionOverlayProps = {
  session?: ClientSession;
  /** Window controls for a frameless window, kept reachable above the scrim. */
  windowChrome?: ReactNode;
  /** How long a dropped link stays a quiet banner before the window is blocked. */
  graceMs?: number;
  /** Tests only: the client's own updater. */
  getUpdatesClient?: () => Promise<ClientUpdatesPort>;
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The link's state over the running app, in client mode only. A drop starts as a quiet banner,
 * because most drops heal within seconds. After the grace period the window is blocked with a
 * dialog over the scrim: calls to the host would only queue, so the app behind it must not look
 * usable. The work itself is untouched; agents keep running on the host.
 */
export function ConnectionOverlay({
  session = getClientSessionStore(),
  windowChrome,
  graceMs = RECONNECT_GRACE_MS,
  getUpdatesClient,
}: ConnectionOverlayProps) {
  const { status } = useClientSession(session);
  const phase = status?.phase;
  const down = phase !== undefined && phase !== 'connected';
  const linking = phase === 'connecting' || phase === 'reconnecting';
  const pastGrace = usePastGrace(down, graceMs);
  const blocking = down && (!linking || pastGrace);

  const card = useRef<HTMLDivElement>(null);
  const blockingRef = useRef(blocking);
  blockingRef.current = blocking;
  const titleId = useId();
  const descriptionId = useId();

  // Registered once, before the workspace mounts its own window listeners, so that while the
  // window is blocked no app shortcut fires and Tab stays inside the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = card.current;
      if (!blockingRef.current || !dialog) return;
      event.stopImmediatePropagation();
      const inside = event.target instanceof Node && dialog.contains(event.target);
      if (event.key !== 'Tab') {
        if (!inside) event.preventDefault();
        return;
      }
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!inside || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Focus moves into the dialog while it blocks and returns to where it was afterwards.
  useEffect(() => {
    if (!blocking) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [blocking]);

  if (!status || !down) return null;

  if (!blocking) {
    return (
      <div
        role="status"
        data-connection-overlay="banner"
        // Level with the title bar, whose middle is empty: it covers no content and takes no clicks.
        className="surface-elevated pointer-events-none fixed top-1.5 left-1/2 z-9990 flex h-7 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-md bg-(--em-surface) px-2.5 text-xs text-foreground shadow-md ring-1 ring-border-subtle motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
      >
        <Spinner size="sm" className="shrink-0 text-foreground-passive" />
        <span className="truncate">Reconnecting to {hostLabel(status.host)}…</span>
      </div>
    );
  }

  return (
    <div
      data-connection-overlay="blocking"
      className="fixed inset-0 z-9990 flex items-center justify-center overflow-y-auto bg-overlay p-4 motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
    >
      {windowChrome}
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="surface-elevated my-auto w-full max-w-130 rounded-xl bg-(--em-surface) p-6 text-sm text-foreground shadow-xl ring-1 ring-border-subtle outline-none"
      >
        {linking ? (
          <ReconnectingPanel
            session={session}
            status={status}
            titleId={titleId}
            descriptionId={descriptionId}
          />
        ) : phase === 'blocked' ? (
          <BlockedPanel
            session={session}
            status={status}
            variant="dialog"
            titleId={titleId}
            descriptionId={descriptionId}
            getUpdatesClient={getUpdatesClient}
          />
        ) : (
          <UnpairedPanel session={session} titleId={titleId} descriptionId={descriptionId} />
        )}
      </div>
    </div>
  );
}

/** True once `active` has held for `graceMs` without a break. */
function usePastGrace(active: boolean, graceMs: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!active) {
      setPast(false);
      return;
    }
    const timer = setTimeout(() => setPast(true), graceMs);
    return () => clearTimeout(timer);
  }, [active, graceMs]);
  return active && past;
}

function ReconnectingPanel({
  session,
  status,
  titleId,
  descriptionId,
}: {
  session: ClientSession;
  status: ClientSessionStatus;
  titleId: string;
  descriptionId: string;
}) {
  const action = useSessionAction();
  const retrying = action.pending === 'retry';
  const attempt = attemptLabel(status.attempt);
  return (
    <StatePanel
      variant="dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      title={
        <span className="flex items-center gap-2.5">
          <Spinner size="sm" className="shrink-0 text-foreground-passive" />
          <span role="status">Reconnecting to {hostLabel(status.host)}…</span>
        </span>
      }
      description="The link to the host dropped. Your agents keep running there, and this window picks up where it was as soon as the link is back."
      error={action.error}
      primary={
        <Button
          type="button"
          variant="primary"
          disabled={action.pending !== null}
          onClick={() => action.run('retry', () => session.retryNow())}
        >
          {retrying ? <Spinner size="sm" /> : null}
          Retry now
        </Button>
      }
      secondary={<QuitAction session={session} disabled={action.pending !== null} />}
    >
      {attempt !== null || status.lastError !== null ? (
        <AttemptLine
          className="text-xs break-words text-foreground-muted"
          attempt={attempt}
          lastError={status.lastError}
        />
      ) : null}
    </StatePanel>
  );
}

/** The stored host is gone while the app was open; only a restart leads back to pairing. */
function UnpairedPanel({
  session,
  titleId,
  descriptionId,
}: {
  session: ClientSession;
  titleId: string;
  descriptionId: string;
}) {
  const action = useSessionAction();
  return (
    <StatePanel
      variant="dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      title="This client is no longer paired"
      description="Its host was forgotten. Restart the client to pair it with a host again."
      error={action.error}
      primary={
        <Button
          type="button"
          variant="primary"
          disabled={action.pending !== null}
          onClick={() => action.run('relaunch', () => session.relaunch())}
        >
          Restart the client
        </Button>
      }
      secondary={<QuitAction session={session} disabled={action.pending !== null} />}
    />
  );
}
