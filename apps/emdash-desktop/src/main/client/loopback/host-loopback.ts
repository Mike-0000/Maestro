import type { Logger } from '@emdash/shared/logger';
import type { Session } from 'electron';
import type { OwnerExternalOpenRequest } from '@core/features/client-mode/api/owner-contract';
import type { ClientConnection } from '../connection-store';
import { startHostLoopbackProxy } from './host-loopback-proxy';
import { createLoopbackMirrors, type LoopbackMirrors } from './loopback-mirror';
import { installSessionProxy, type SessionProxyApp } from './session-proxy';
import {
  createHostTunnelDialer,
  hostLoopbackFamilies,
  ownerTunnelConnector,
} from './tunnel-dialer';

// In client mode `localhost` means the host: a dev server the host's agents started is at
// `http://localhost:5173` on the host. This wires the three ways this computer reaches it:
// the embedded browser through the loopback proxy, and this computer's own browser (an "open in
// browser" of a preview, or an OAuth sign-in the host started) through loopback mirrors.

export type HostLoopback = {
  /**
   * Opens a URL in this computer's browser. A host-loopback URL is opened through a local mirror
   * of that port (with the mirror's port if the original one is taken here).
   */
  openExternal(url: string): Promise<void>;
  /** A host open request whose page sends the browser back to a host loopback port (OAuth). */
  openLoopbackRequest(request: OwnerExternalOpenRequest): Promise<void>;
  close(): Promise<void>;
};

export async function startHostLoopback(deps: {
  connection: Pick<ClientConnection, 'url' | 'token' | 'cfAccess'>;
  /** Resolves once the owner session is attached. */
  ready(): Promise<unknown>;
  app: SessionProxyApp;
  defaultSession: Session;
  /** Opens a URL in this computer's browser. */
  openInBrowser(url: string): Promise<void>;
  log: Pick<Logger, 'info' | 'debug' | 'warn'>;
}): Promise<HostLoopback> {
  const dialTunnel = createHostTunnelDialer({
    connect: ownerTunnelConnector(deps.connection),
    ready: deps.ready,
  });
  const proxy = await startHostLoopbackProxy({ dialTunnel, log: deps.log });
  const uninstall = installSessionProxy({
    app: deps.app,
    defaultSession: deps.defaultSession,
    proxy,
    log: deps.log,
  });
  const mirrors = createLoopbackMirrors({ dialTunnel, log: deps.log });
  const opener = { mirrors, open: deps.openInBrowser };
  deps.log.info('client mode: host loopback proxy ready', { port: proxy.port });

  return {
    openExternal: (url) => openHostUrl(url, opener),
    openLoopbackRequest: (request) => openHostLoopbackRequest(request, opener),
    async close() {
      uninstall();
      await Promise.all([mirrors.close(), proxy.close()]);
    },
  };
}

type Opener = { mirrors: Pick<LoopbackMirrors, 'ensure'>; open(url: string): Promise<void> };

/** The host port a URL names on the host's loopback, or null for any other URL. */
export function hostLoopbackUrlTarget(value: string): { port: number; hostname: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!hostLoopbackFamilies(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return { port, hostname: url.hostname };
}

/** Opens `url`; a host-loopback URL first gets a local mirror and that mirror's port. */
export async function openHostUrl(url: string, opener: Opener): Promise<void> {
  const target = hostLoopbackUrlTarget(url);
  if (!target) {
    await opener.open(url);
    return;
  }
  const localPort = await opener.mirrors.ensure({ ...target, samePort: false });
  await opener.open(withPort(url, localPort, target.port));
}

/**
 * An OAuth sign-in on the host: the provider's page opens here and sends the browser back to
 * `http://127.0.0.1:<loopbackPort>/callback`, so that exact port is mirrored first.
 */
export async function openHostLoopbackRequest(
  request: OwnerExternalOpenRequest,
  opener: Opener
): Promise<void> {
  if (request.loopbackPort !== undefined) {
    await opener.mirrors.ensure({
      port: request.loopbackPort,
      hostname: '127.0.0.1',
      samePort: true,
    });
  }
  await openHostUrl(request.url, opener);
}

function withPort(value: string, localPort: number, hostPort: number): string {
  if (localPort === hostPort) return value;
  const url = new URL(value);
  url.port = String(localPort);
  return url.toString();
}
