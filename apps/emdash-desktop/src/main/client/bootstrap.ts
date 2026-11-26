import { hostname } from 'node:os';
import { join } from 'node:path';
import { createScope } from '@emdash/shared/concurrency';
import { connectWebSocketPipe } from '@emdash/wire/node';
import type { Controller } from '@emdash/wire/rpc';
import { app, ipcMain, powerMonitor, safeStorage, session, shell } from 'electron';
import _electronUpdater from 'electron-updater';
import { createBrowserWireController } from '@core/features/browser/node/wire-controller';
import { clientSessionDomain } from '@core/features/client-mode/api/client-session-contract';
import { createUpdatesWireController } from '@core/features/updates/node/wire-controller';
import { desktopHostEvents } from '@core/features/workbench/node';
import { createDesktopHostWireController } from '@core/features/workbench/node/wire-controller';
import { CLIENT_MODE_RENDERER_SEARCH } from '@core/primitives/client-mode/api/client-mode-search';
import { createLoggingWireController } from '@core/services/logging/node/wire-controller';
import { runBootPreflight } from '@main/bootstrap/boot/preflight';
import { isBootAborted, type BootSignals } from '@main/bootstrap/boot/types';
import { setAppConfig } from '@main/bootstrap/core/config';
import { setCoreServiceInstances } from '@main/bootstrap/core/service-instances';
import { appOperations } from '@main/core/app/controller';
import { terminalFileSources } from '@main/core/app/persist-terminal-attachment';
import { installDesktopWire, registerDesktopWireControllers } from '@main/gateway/desktop-wire';
import { setBrowserCorsRelaxationSettings } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { browserOperations } from '@main/host/browser/controller';
import { writeRendererLogEntry } from '@main/host/file-logger';
import { setupApplicationMenu } from '@main/host/menu';
import { createSystemNotificationSink } from '@main/host/notifications/system-notification-sink';
import { setupAppProtocol } from '@main/host/protocol';
import { updateOperations } from '@main/host/updates/controller-operations';
import { updateService } from '@main/host/updates/update-service';
import {
  applyNativeTheme,
  configureMainWindow,
  createMainWindow,
  getMainWindow,
} from '@main/host/window';
import { log } from '@main/lib/logger';
import { resolveBuildIdentity } from '@main/owner-link/build-identity';
import { ownerDialOptions, ownerWireUrl } from '@main/owner-link/endpoints';
import {
  applyHostSettingsLocally,
  clientSettingsRuntime,
  createClientAppSettingsController,
  createRemoteAppSettings,
  type RemoteAppSettings,
} from './adapters/app-settings';
import { createClientDevPerfController } from './adapters/dev-perf';
import { startExternalOpenBridge } from './adapters/external-open';
import { createClientHostOperations, type LocalHostOperations } from './adapters/host-operations';
import { startOwnerNotificationBridge } from './adapters/notifications';
import { guardClientUpdates, isLocalAppRunning, listProcessesNamedLike } from './adapters/updates';
import {
  CLIENT_APP_USER_MODEL_ID,
  buildClientAppConfig,
  clientLaunchSwitch,
  clientWindowTitle,
} from './client-config';
import {
  buildClientControllers,
  createClientConversationsController,
  createClientTerminalsController,
  createClientVoiceController,
  queuedOwnerClient,
  type ClientHandledDomain,
} from './client-controllers';
import { createClientSessionController } from './client-session-controller';
import { createClientShutdown, type ClientShutdown } from './client-shutdown';
import { createConnectionStore, type ClientConnection } from './connection-store';
import { createHostLink, type HostLink } from './host-link';
import { resolveLaunchMode } from './launch-mode';
import {
  hostLoopbackUrlTarget,
  startHostLoopback,
  type HostLoopback,
} from './loopback/host-loopback';
import { createClientShortcuts } from './shortcut';

// Client mode (`--maestro-client`): a thin main process whose renderer is the ordinary Maestro UI.
// It runs only the window, the menu, the Wire gateway, the updater, the embedded browser and the
// link to the host. There is no database, no worker, no scheduler and no local recovery: every
// host-side domain is forwarded to the host over the owner link (see `client-controllers.ts`).

const DIAL_TIMEOUT_MS = 15_000;
const WEBSOCKET_PING_INTERVAL_MS = 10_000;

export async function clientMain(): Promise<void> {
  const launch = resolveLaunchMode(process.argv, process.env, { isPackaged: app.isPackaged });
  const profile = launch.mode === 'client' ? launch.profile : null;
  const config = buildClientAppConfig(profile, app.getPath('appData'));
  setAppConfig(config);
  if (process.platform === 'win32') app.setAppUserModelId(CLIENT_APP_USER_MODEL_ID);

  const signals: BootSignals = { windowPhaseReady: false };
  try {
    await runBootPreflight(config, signals);
  } catch (error) {
    // Another window of this client profile already runs; it was brought to the front.
    if (isBootAborted(error)) return;
    throw error;
  }
  log.info('client mode: starting', { profile, userData: app.getPath('userData') });
  registerBootChannels();

  setupAppProtocol(join(app.getAppPath(), 'out', 'renderer'));
  setupApplicationMenu();
  // The renderer requests its port as soon as it boots; traffic queues until the bundle below
  // is registered, as in the local app's window-first boot.
  installDesktopWire();
  configureMainWindow({
    rendererSearch: CLIENT_MODE_RENDERER_SEARCH,
    title: clientWindowTitle(profile),
  });

  const lifetime = new AbortController();
  const build = await resolveBuildIdentity({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    resourcesPath: process.resourcesPath,
  });
  const store = createConnectionStore({
    userDataDir: app.getPath('userData'),
    cipher: safeStorage,
    log,
  });
  const link = createHostLink({
    build,
    clientName: hostname() || 'Maestro client',
    clientPlatform: process.platform,
    log,
    dial: (connection, signal) =>
      connectWebSocketPipe(
        ownerDialOptions(
          ownerWireUrl(connection.url),
          { token: connection.token, cfAccess: connection.cfAccess },
          { signal, timeoutMs: DIAL_TIMEOUT_MS, pingIntervalMs: WEBSOCKET_PING_INTERVAL_MS }
        )
      ),
    onHostChanged: reloadMainWindow,
  });
  const shutdown = createClientShutdown({
    emit: (event) => desktopHostEvents.emit(undefined, event),
    closeLink: () => {
      lifetime.abort();
      link.close();
    },
    exit: (code) => app.exit(code),
    log,
  });

  const ready = () => link.ready();
  const remoteSettings = createRemoteAppSettings(ready);
  const settingsRuntime = clientSettingsRuntime({
    setKeyboardSettings: (settings) => browserWebContentsRegistry.setKeyboardSettings(settings),
    setBrowserSettings: setBrowserCorsRelaxationSettings,
    setTheme: applyNativeTheme,
  });
  setCoreServiceInstances(clientCoreServices(remoteSettings));
  link.onAttached(() => {
    applyHostSettingsLocally(remoteSettings, settingsRuntime).catch((error: unknown) =>
      log.warn('client mode: could not apply the host settings locally', { error })
    );
  });
  // Dial before the window exists, so the gate's first status snapshot is already the real one.
  const saved = await store.load();
  link.start(saved);
  // Before the window, so every browser session it creates reaches the host's loopback.
  const loopback = saved ? await startLoopback(saved, ready, lifetime.signal) : null;

  const scope = createScope({ label: 'client-controllers' });
  const host = queuedOwnerClient(ready);
  const controllers = buildClientControllers({
    host,
    handled: createHandledControllers({
      host,
      loopback,
      remoteSettings,
      settingsRuntime,
      shutdown,
    }),
    extra: {
      [clientSessionDomain]: createClientSessionController({
        link,
        store,
        deviceName: hostname() || 'Maestro client',
        relaunch: () => relaunch(shutdown),
        createShortcut: async () =>
          createClientShortcuts({
            platform: process.platform,
            writeShortcutLink: (path, operation, options) =>
              shell.writeShortcutLink(path, operation, options),
            desktopDir: app.getPath('desktop'),
            appDataDir: app.getPath('appData'),
            execPath: process.execPath,
            appPath: app.isPackaged ? null : app.getAppPath(),
            title: clientWindowTitle(profile),
            launchSwitch: clientLaunchSwitch(profile),
            appUserModelId: CLIENT_APP_USER_MODEL_ID,
          }),
        scope,
        log,
      }),
    },
  });
  registerDesktopWireControllers({ controllers, scope });

  const window = createMainWindow();
  // Keep "Maestro Client" in the title bar instead of the page's own title.
  window.on('page-title-updated', (event) => event.preventDefault());
  // The window hides itself on close (local behaviour); a client has no tray, so it quits.
  window.on('close', () => shutdown.requestQuit());
  app.on('before-quit', (event) => {
    event.preventDefault();
    shutdown.requestQuit();
  });
  signals.windowPhaseReady = true;

  watchSystemWake(link);
  startOwnerNotificationBridge({
    host: ready,
    createSink: createSystemNotificationSink,
    signal: lifetime.signal,
    log,
  });
  startExternalOpenBridge({
    host: ready,
    openExternal: (url) => (loopback ? loopback.openExternal(url) : shell.openExternal(url)),
    openLoopback: loopback ? (request) => loopback.openLoopbackRequest(request) : undefined,
    signal: lifetime.signal,
    log,
  });

  void initializeClientUpdater();
}

/**
 * The host's loopback for this computer: the embedded browser's proxy and the mirrors behind
 * "open in browser" and OAuth. A failure leaves the client usable without host previews.
 */
async function startLoopback(
  connection: ClientConnection,
  ready: () => Promise<unknown>,
  signal: AbortSignal
): Promise<HostLoopback | null> {
  try {
    const loopback = await startHostLoopback({
      connection,
      ready,
      app,
      defaultSession: session.defaultSession,
      openInBrowser: (url) => shell.openExternal(url),
      log,
    });
    signal.addEventListener('abort', () => void loopback.close(), { once: true });
    return loopback;
  } catch (error) {
    log.warn('client mode: host loopback unavailable', { error });
    return null;
  }
}

function createHandledControllers(deps: {
  host: ReturnType<typeof queuedOwnerClient>;
  loopback: HostLoopback | null;
  remoteSettings: RemoteAppSettings;
  settingsRuntime: ReturnType<typeof clientSettingsRuntime>;
  shutdown: ClientShutdown;
}): Record<ClientHandledDomain, Controller> {
  return {
    appSettings: createClientAppSettingsController(deps.remoteSettings, deps.settingsRuntime),
    browser: createBrowserWireController(browserOperations),
    conversations: createClientConversationsController(deps.host, {
      localFiles: terminalFileSources,
      logger: log,
    }),
    devPerf: createClientDevPerfController(log),
    host: createDesktopHostWireController(
      createClientHostOperations({
        local: localHostOperations(deps.loopback),
        host: async () => deps.host,
        shutdown: deps.shutdown,
      })
    ),
    logging: createLoggingWireController({
      writeRendererLog: (input) => writeRendererLogEntry(input),
    }),
    terminals: createClientTerminalsController(deps.host, {
      localFiles: terminalFileSources,
      logger: log,
    }),
    updates: guardClientUpdates(createUpdatesWireController(updateOperations), () =>
      isLocalAppRunning({
        listProcesses: () => listProcessesNamedLike(process.execPath),
        execPath: process.execPath,
        pid: process.pid,
        platform: process.platform,
      })
    ),
    voice: createClientVoiceController(deps.host, openMicrophoneSettings),
  };
}

/**
 * The local half of `host`, from the same operations the local app uses. A URL on the host's
 * loopback (a preview's "open in browser") opens through a local mirror of that port.
 */
function localHostOperations(loopback: HostLoopback | null): LocalHostOperations {
  return {
    openExternal: async ({ url }) => {
      if (!loopback || !hostLoopbackUrlTarget(url)) return await appOperations.openExternal(url);
      try {
        await loopback.openExternal(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    clipboardWriteText: ({ text }) => appOperations.clipboardWriteText(text),
    persistClipboardImage: () => appOperations.persistClipboardImage(),
    showTerminalContextMenu: (input) => appOperations.showTerminalContextMenu(input),
    setMenuKeybindings: (input) => appOperations.setMenuKeybindings(input),
    checkInstalledApps: () => appOperations.checkInstalledApps(),
    listInstalledFonts: (input) => appOperations.listInstalledFonts(input),
    openSelectDirectoryDialog: (input) => appOperations.openSelectDirectoryDialog(input),
    openSelectAudioFileDialog: (input) => appOperations.openSelectAudioFileDialog(input),
    saveTextFile: (input) => appOperations.saveTextFile(input),
    readAudioFileDataUrl: ({ filePath }) => appOperations.readAudioFileDataUrl(filePath),
    minimizeWindow: () => appOperations.minimizeWindow(),
    toggleMaximizeWindow: () => appOperations.toggleMaximizeWindow(),
    closeWindow: () => appOperations.closeWindow(),
    isWindowMaximized: () => appOperations.isWindowMaximized(),
    getAppVersion: () => appOperations.getAppVersion(),
    getElectronVersion: () => appOperations.getElectronVersion(),
    getPlatformDisplayName: () => appOperations.getPlatformDisplayName(),
    getDiagnosticLogAttachment: () => appOperations.getDiagnosticLogAttachment(),
    submitFeedback: (input) => appOperations.submitFeedback(input),
  };
}

/**
 * Only app settings are reachable from a client's main process (the embedded browser reads its
 * profiles there). The other core services belong to the host; touching one is a bug, so it
 * fails loudly instead of answering from an empty local store.
 */
function clientCoreServices(
  appSettings: RemoteAppSettings
): Parameters<typeof setCoreServiceInstances>[0] {
  const unavailable = <T extends object>(name: string): T =>
    new Proxy({} as T, {
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error(`${name} is not available in a Maestro client (${String(property)})`);
      },
    });
  return {
    // Boundary cast: only the reading and writing methods are ever called on a client.
    appSettings: appSettings as Parameters<typeof setCoreServiceInstances>[0]['appSettings'],
    account: unavailable('The account service'),
    notifications: unavailable('The notification service'),
    promptLibrary: unavailable('The prompt library'),
    providerSettings: unavailable('Provider settings'),
  };
}

/**
 * The splash's escape hatch and boot report use direct channels (see the local bootstrap). A
 * client can only restart; it has no recovery window and keeps no boot report.
 */
function registerBootChannels(): void {
  ipcMain.handle('emdash:boot-escape', (_event, action: unknown) => {
    log.warn('client mode: boot escape hatch requested', { action });
    if (action === 'restart') {
      app.relaunch();
      app.exit(0);
    }
  });
  ipcMain.on('emdash:boot-usable-workspace', () => {});
}

function watchSystemWake(link: HostLink): void {
  const probe = () => link.probe();
  powerMonitor.on('resume', probe);
  powerMonitor.on('unlock-screen', probe);
}

function reloadMainWindow(): void {
  const window = getMainWindow();
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.reload();
  }
}

/** Restarts this client with the same switches, after the current Wire reply is on its way. */
function relaunch(shutdown: ClientShutdown): void {
  setTimeout(() => {
    app.relaunch();
    shutdown.requestQuit();
  }, 150);
}

async function openMicrophoneSettings(): Promise<void> {
  const url =
    process.platform === 'win32'
      ? 'ms-settings:privacy-microphone'
      : process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : null;
  if (url) await shell.openExternal(url);
}

/**
 * The ordinary updater (rule U guards download and install). An update is never installed on
 * quit: the installation is shared with the local app, which may be running agents.
 */
async function initializeClientUpdater(): Promise<void> {
  try {
    await updateService.initialize();
    if (updateService.isActive) _electronUpdater.autoUpdater.autoInstallOnAppQuit = false;
  } catch (error) {
    log.warn('client mode: failed to initialize the updater', { error });
  }
}
