import type { Controller } from '@emdash/wire/rpc';
import type { AppSettings, AppSettingsKey } from '@core/services/settings/api';
import type { AppSettingsService } from '@core/services/settings/node';
import {
  createAppSettingsWireController,
  type SettingsRuntimePort,
} from '@core/services/settings/node/wire-controller';
import type { OwnerHostClient } from '../host-link';

// Settings live on the host (D8). The client reads and writes them over the link, and mirrors the
// side effects that touch its own Electron state: the native theme, the webview keyboard registry
// and the browser CORS relaxation.

/** The reading and writing half of `AppSettingsService`, answered by the host. */
export type RemoteAppSettings = Pick<
  AppSettingsService,
  'get' | 'getAll' | 'getWithMeta' | 'update' | 'reset' | 'resetField'
>;

export function createRemoteAppSettings(host: () => Promise<OwnerHostClient>): RemoteAppSettings {
  const settings = async () => (await host()).desktop.appSettings;
  return {
    // The wire contract erases the key-to-value typing; the host answers for the same key.
    get: (async (key: AppSettingsKey) =>
      await (await settings()).get({ key })) as RemoteAppSettings['get'],
    getAll: async () => await (await settings()).getAll(undefined),
    getWithMeta: (async (key: AppSettingsKey) =>
      await (await settings()).getWithMeta({ key })) as RemoteAppSettings['getWithMeta'],
    update: async <K extends AppSettingsKey>(key: K, value: AppSettings[K]) => {
      await (await settings()).update({ key, value });
    },
    reset: async <K extends AppSettingsKey>(key: K) => {
      await (await settings()).reset({ key });
    },
    resetField: async <K extends AppSettingsKey>(key: K, field: keyof AppSettings[K]) => {
      await (await settings()).resetField({ key, field: String(field) });
    },
  };
}

/** The client's own settings effects; the tray is the host's business, so it is a no-op here. */
export function clientSettingsRuntime(
  effects: Omit<SettingsRuntimePort, 'setTrayVisible'>
): SettingsRuntimePort {
  return { ...effects, setTrayVisible: () => {} };
}

/**
 * `appSettings` for the renderer: every call goes to the host, then the same reconciliation the
 * local app runs applies the client-side effects of `theme`, `keyboard` and `browser`.
 */
export function createClientAppSettingsController(
  settings: RemoteAppSettings,
  runtime: SettingsRuntimePort
): Controller {
  // Boundary cast: the controller only calls the six methods `RemoteAppSettings` provides.
  return createAppSettingsWireController(settings as AppSettingsService, runtime);
}

/** Applies the host's current settings to the client; run after every attach. */
export async function applyHostSettingsLocally(
  settings: RemoteAppSettings,
  runtime: SettingsRuntimePort
): Promise<void> {
  const [theme, keyboard, browser] = await Promise.all([
    settings.get('theme'),
    settings.get('keyboard'),
    settings.get('browser'),
  ]);
  runtime.setTheme(theme);
  runtime.setKeyboardSettings(keyboard);
  runtime.setBrowserSettings(browser);
}
