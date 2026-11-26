import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  HOST_LOOPBACK_BYPASS_RULES,
  installSessionProxy,
  type SessionProxyApp,
} from './session-proxy';

const PROXY = {
  port: 41_234,
  username: 'maestro',
  password: 'p'.repeat(64),
  proxyRules: '127.0.0.1:41234',
};

function fakeSession() {
  return { setProxy: vi.fn(async () => {}) } as unknown as Session & {
    setProxy: ReturnType<typeof vi.fn>;
  };
}

function setup() {
  const app = new EventEmitter();
  const defaultSession = fakeSession();
  const log = { warn: vi.fn() };
  const uninstall = installSessionProxy({
    app: app as unknown as SessionProxyApp,
    defaultSession,
    proxy: PROXY,
    log,
  });
  const login = (authInfo: { isProxy: boolean; host: string; port: number }) => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    app.emit('login', event, {}, { url: 'http://localhost:5173/' }, authInfo, callback);
    return { event, callback };
  };
  return { app, defaultSession, log, uninstall, login };
}

describe('client browser sessions', () => {
  it('routes every non-default session loopback-only through the proxy', () => {
    const { app } = setup();
    const browser = fakeSession();
    app.emit('session-created', browser);
    expect(browser.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: '127.0.0.1:41234',
      proxyBypassRules: '*;<-loopback>',
    });
    expect(HOST_LOOPBACK_BYPASS_RULES).toBe('*;<-loopback>');
  });

  it('leaves the default session (the app window) alone', () => {
    const { app, defaultSession } = setup();
    app.emit('session-created', defaultSession);
    expect(defaultSession.setProxy).not.toHaveBeenCalled();
  });

  it('answers the challenge of this proxy only', () => {
    const { login } = setup();
    const ours = login({ isProxy: true, host: '127.0.0.1', port: PROXY.port });
    expect(ours.event.preventDefault).toHaveBeenCalled();
    expect(ours.callback).toHaveBeenCalledWith(PROXY.username, PROXY.password);

    for (const other of [
      { isProxy: false, host: '127.0.0.1', port: PROXY.port },
      { isProxy: true, host: '127.0.0.1', port: PROXY.port + 1 },
      { isProxy: true, host: 'corporate-proxy.example.com', port: PROXY.port },
    ]) {
      const result = login(other);
      expect(result.event.preventDefault).not.toHaveBeenCalled();
      expect(result.callback).not.toHaveBeenCalled();
    }
  });

  it('removes both listeners on uninstall', () => {
    const { app, uninstall } = setup();
    expect(app.listenerCount('session-created')).toBe(1);
    expect(app.listenerCount('login')).toBe(1);
    uninstall();
    expect(app.listenerCount('session-created')).toBe(0);
    expect(app.listenerCount('login')).toBe(0);
  });

  it('logs a session it could not configure instead of throwing', async () => {
    const { app, log } = setup();
    const broken = fakeSession();
    broken.setProxy.mockRejectedValueOnce(new Error('nope'));
    app.emit('session-created', broken);
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());
  });
});

// The local-mode guarantee: the proxy exists only in client mode. Nothing outside this folder
// sets a proxy on a session, answers proxy logins, or listens for new sessions, and only the
// client bootstrap imports this folder (whose own importers are pinned by the client-mode
// boundary test in `client-mode-routing.test.ts`). Local browser sessions are set up exactly as
// before, in files this workstream does not touch.
describe('local mode', () => {
  const SRC = resolve(__dirname, '..', '..', '..');
  const LOOPBACK = resolve(__dirname);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  const files = sourceFiles(SRC);
  const outside = files.filter((file) => !file.startsWith(LOOPBACK + sep));
  const rel = (file: string) => relative(SRC, file).split(sep).join('/');

  it('has no session proxy, proxy login or session-created hook outside client mode', () => {
    const offenders = outside.filter((file) =>
      /\.setProxy\(|['"]session-created['"]|<-loopback>/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it('is imported only by the client bootstrap', () => {
    const importers = outside.filter((file) =>
      /from\s+['"](?:\.\/|@main\/client\/)loopback\//.test(readFileSync(file, 'utf8'))
    );
    expect(importers.map(rel)).toEqual(['main/client/bootstrap.ts']);
  });
});
