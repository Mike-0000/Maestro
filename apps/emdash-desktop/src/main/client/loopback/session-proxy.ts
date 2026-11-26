import type { Logger } from '@emdash/shared/logger';
import type { App, Session } from 'electron';
import type { HostLoopbackProxy } from './host-loopback-proxy';

// Client mode only: every browser session (each embedded-browser profile and isolated partition;
// anything but the default session, which serves the app's own window) sends loopback requests to
// the host loopback proxy, and everything else direct.
//
// Chromium never proxies loopback by default. The bypass list below turns that around:
// `<-loopback>` removes the implicit loopback bypass, and `*` before it sends every other host
// direct. Later rules win in Chromium's bypass matcher, so `localhost`, `*.localhost`,
// `127.0.0.0/8` and `[::1]` match `<-loopback>` (proxied) and everything else matches `*`
// (direct). Verified on Electron 40.10.2 / Chromium 144 for page loads, `*.localhost`, IPv6
// loopback, LAN addresses (direct) and WebSockets (sent as CONNECT), including a navigation
// started right after the session was created.

export const HOST_LOOPBACK_BYPASS_RULES = '*;<-loopback>';

type LoginAuthInfo = { isProxy: boolean; host: string; port: number };
type LoginCallback = (username?: string, password?: string) => void;

export type SessionProxyApp = Pick<App, 'on' | 'removeListener'>;

/**
 * Applies the proxy to every non-default session created from now on and answers the proxy's
 * credential challenge. Returns a function that removes both listeners.
 */
export function installSessionProxy(deps: {
  app: SessionProxyApp;
  defaultSession: Session;
  proxy: Pick<HostLoopbackProxy, 'port' | 'username' | 'password' | 'proxyRules'>;
  log: Pick<Logger, 'warn'>;
}): () => void {
  const onSessionCreated = (created: Session): void => {
    if (created === deps.defaultSession) return;
    created
      .setProxy({
        mode: 'fixed_servers',
        proxyRules: deps.proxy.proxyRules,
        proxyBypassRules: HOST_LOOPBACK_BYPASS_RULES,
      })
      .catch((error: unknown) =>
        deps.log.warn('client mode: could not route a browser session to the host', { error })
      );
  };

  const onLogin = (
    event: { preventDefault(): void },
    _webContents: unknown,
    _details: unknown,
    authInfo: LoginAuthInfo,
    callback: LoginCallback
  ): void => {
    // Only this proxy's challenge; a site's own login prompt is left to the default handling.
    if (!authInfo.isProxy || authInfo.port !== deps.proxy.port) return;
    if (authInfo.host !== '127.0.0.1') return;
    event.preventDefault();
    callback(deps.proxy.username, deps.proxy.password);
  };

  // Boundary casts: Electron's overloads type each event separately; these are the shapes above.
  const app = deps.app as unknown as {
    on(event: string, listener: (...args: never[]) => void): unknown;
    removeListener(event: string, listener: (...args: never[]) => void): unknown;
  };
  app.on('session-created', onSessionCreated);
  app.on('login', onLogin);
  return () => {
    app.removeListener('session-created', onSessionCreated);
    app.removeListener('login', onLogin);
  };
}
