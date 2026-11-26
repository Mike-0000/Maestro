import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as AppConfigModule from '@main/bootstrap/core/config';
import type * as ShutdownModule from '@main/bootstrap/shutdown';
import type * as DbInstance from '@main/db/instance';

// Client mode must boot and answer every client-local procedure without the local backend: no
// database, no quit coordinator, no runtime worker. Electron is a recording stand-in; the
// database and the worker host fail loudly if anything reaches them.

const state = await vi.hoisted(async () => {
  // Electron's `app.getPath` must answer before any module is evaluated.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'client-coupling-')),
    imported: [] as string[],
    appHandlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  };
});

const spies = vi.hoisted(() => ({
  getAppDb: vi.fn(() => {
    throw new Error('client mode touched the database');
  }),
  registerQuitHandler: vi.fn(),
  // The test setup already set the process-wide config; record the client's instead.
  setAppConfig: vi.fn(),
  exit: vi.fn(),
}));

vi.mock('electron', () => {
  /** Anything not spelled out below: callable, constructible, every property another stand-in. */
  const deep = (): unknown => {
    const cache = new Map<PropertyKey, unknown>();
    const target = function stand_in() {};
    return new Proxy(target, {
      get(_t, property) {
        if (property === 'then') return undefined;
        if (property === Symbol.toPrimitive) return () => '';
        if (property === 'isDestroyed') return () => false;
        if (!cache.has(property)) cache.set(property, deep());
        return cache.get(property);
      },
      apply: () => deep(),
      construct: () => deep() as object,
    });
  };
  const app = new Proxy(
    {
      isPackaged: false,
      commandLine: deep(),
      getPath: (name: string) => join(state.root, name),
      setPath: () => {},
      getAppPath: () => state.root,
      getVersion: () => '1.0.0-test',
      getName: () => 'Maestro',
      setName: () => {},
      setAppUserModelId: () => {},
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on: (event: string, handler: (...args: unknown[]) => void) => {
        state.appHandlers.set(event, [...(state.appHandlers.get(event) ?? []), handler]);
      },
      relaunch: () => {},
      exit: spies.exit,
      quit: () => {},
      focus: () => {},
      dock: undefined,
    } as Record<PropertyKey, unknown>,
    {
      get(target, property) {
        if (property in target) return target[property];
        return deep();
      },
    }
  );
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const names = [
    'BrowserWindow',
    'nativeTheme',
    'ipcMain',
    'MessageChannelMain',
    'powerMonitor',
    'shell',
    'clipboard',
    'dialog',
    'Menu',
    'protocol',
    'net',
    'session',
    'webContents',
    'Notification',
    'contentTracing',
    'nativeImage',
    'screen',
    'systemPreferences',
    'globalShortcut',
    'Tray',
    'utilityProcess',
    'desktopCapturer',
  ];
  const module: Record<string, unknown> = { app, safeStorage };
  for (const name of names) module[name] = deep();
  return { ...module, default: module };
});

vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: () => {}, autoInstallOnAppQuit: true } },
}));

vi.mock('@main/db/instance', async (importOriginal) => ({
  ...(await importOriginal<typeof DbInstance>()),
  getAppDb: spies.getAppDb,
}));

vi.mock('@main/bootstrap/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof AppConfigModule>()),
  setAppConfig: spies.setAppConfig,
}));

vi.mock('@main/bootstrap/shutdown', async (importOriginal) => ({
  ...(await importOriginal<typeof ShutdownModule>()),
  registerQuitHandler: spies.registerQuitHandler,
}));

vi.mock('@main/gateway/desktop-workers', () => {
  state.imported.push('desktop-workers');
  return {};
});

vi.mock('@main/gateway/desktop-runtimes', () => {
  state.imported.push('desktop-runtimes');
  return {};
});

afterAll(() => {
  rmSync(state.root, { recursive: true, force: true });
});

describe('client mode coupling', () => {
  it('boots and answers client-local procedures without the local backend', async () => {
    process.argv = [...process.argv, '--maestro-client'];
    // Electron's own addition to `process`, read by the window's boot-timeline marks.
    Object.assign(process, { getCreationTime: () => Date.now() });
    const { clientMain } = await import('./bootstrap');
    await clientMain();
    const { createDesktopWireController } = await import('@main/gateway/desktop-wire');
    const desktop = createDesktopWireController();

    const calls: Array<[string, unknown]> = [
      ['clientSession.retryNow', undefined],
      ['host.getAppVersion', undefined],
      ['host.setMenuKeybindings', []],
      ['host.shutdownReady', undefined],
      ['host.resolveQuitConfirmation', { requestId: 'r', confirmed: true }],
      ['logging.writeRendererLog', { level: 'info', source: 'renderer', input: ['hello'] }],
      ['devPerf.getVerboseSpawnLogging', undefined],
      ['updates.getState', undefined],
      ['browser.getActiveBrowser', undefined],
      ['browser.setActiveBrowser', { browserId: null }],
      ['voice.openMicrophoneSettings', undefined],
    ];
    for (const [path, input] of calls) {
      await expect(desktop.call(path, input), path).resolves.not.toThrow();
    }
    await expect(desktop.call('host.openIn', { app: 'vscode', path: '/x' })).resolves.toEqual({
      success: false,
      error: expect.stringContaining('client mode'),
    });

    expect(spies.setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ telemetryEnabled: false, userDataDir: expect.any(String) })
    );
    expect(spies.getAppDb).not.toHaveBeenCalled();
    expect(spies.registerQuitHandler).not.toHaveBeenCalled();
    expect(state.imported).toEqual([]);
    expect(state.appHandlers.has('before-quit')).toBe(true);
    expect(spies.exit).not.toHaveBeenCalled();
  }, 60_000);
});
