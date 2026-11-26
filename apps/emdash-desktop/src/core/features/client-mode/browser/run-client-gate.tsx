import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { registerClientTitlebarStatus } from '@core/primitives/client-mode/browser/titlebar-status';
import { ClientConnectionPill } from '../contributions/browser/client-connection-pill';
import { ClientGate } from './client-gate';
import { getClientSessionStore, type ClientSession } from './client-session-store';

const SPLASH_ID = 'boot-splash';
const GATE_ROOT_ID = 'client-gate-root';

/** A link that attaches within this long never shows the gate: the splash covers it. */
export const CLIENT_GATE_GRACE_MS = 1200;

export type RunClientGateOptions = {
  session?: ClientSession;
  /** Window controls for a frameless window, drawn over the gate. */
  windowChrome?: ReactNode;
  graceMs?: number;
};

function delay(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

/** The static boot splash paints above everything, so the gate takes its place while it shows. */
function setSplashHidden(hidden: boolean): void {
  const splash = document.getElementById(SPLASH_ID);
  if (splash) splash.style.display = hidden ? 'none' : '';
}

/**
 * Holds the renderer bootstrap until this client is attached to its host. Call it only in client
 * mode, after the wire connection is seeded and before anything asks the host for data.
 *
 * A saved host that answers quickly passes straight through behind the boot splash. Otherwise the
 * gate replaces the splash (pairing, connecting, or why the host refused) and hands back to it
 * once the link is attached, so the app still boots behind the same splash as a local window.
 *
 * It also gives the title bars their link pill, the one piece of client chrome inside the app.
 */
export async function runClientGate(options: RunClientGateOptions = {}): Promise<void> {
  const session = options.session ?? getClientSessionStore();
  registerClientTitlebarStatus(ClientConnectionPill);
  session.start();
  await session.whenLoaded();

  const first = session.getSnapshot().status;
  if (first?.phase === 'connected') return;
  if (first?.phase === 'connecting' && first.host) {
    const attached = await Promise.race([
      session.whenConnected().then(() => true as const),
      delay(options.graceMs ?? CLIENT_GATE_GRACE_MS),
    ]);
    if (attached) return;
  }

  const container = document.createElement('div');
  container.id = GATE_ROOT_ID;
  document.body.append(container);
  const root = createRoot(container);
  // Painted before the splash goes, so the window never shows an empty frame between them.
  flushSync(() =>
    root.render(<ClientGate session={session} windowChrome={options.windowChrome} />)
  );
  setSplashHidden(true);

  await session.whenConnected();

  setSplashHidden(false);
  root.unmount();
  container.remove();
}
