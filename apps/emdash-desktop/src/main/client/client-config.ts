import { join } from 'node:path';
import {
  APP_ID,
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
} from '@core/primitives/app-identity/api/app-identity';
import { clientUserDataDirName } from '@core/primitives/client-mode/api/client-profile';
import { loadAppConfig, type AppConfig } from '@main/bootstrap/core/config';

// The configuration a client-mode process boots with. Electron-free: the caller passes the
// `appData` path (`app.getPath('appData')`, available before `ready`).

/** The Windows taskbar identity of a client window, so it never groups with the local app. */
export const CLIENT_APP_USER_MODEL_ID = `${APP_ID}.client`;

/**
 * The app config of a client process: the usual environment-derived config, with its own profile
 * directory beside the local app's and telemetry off. `EMDASH_USER_DATA_DIR` still wins, so a
 * scratch client can be pointed anywhere; otherwise the profile is
 * `<appData>/<userDataDirName>-client[-<profile>]`. Setting the directory explicitly also keeps
 * the one-time legacy profile import (local mode only) from ever running for a client.
 */
export function buildClientAppConfig(
  profile: string | null,
  appDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  const base = loadAppConfig(env);
  return {
    ...base,
    userDataDir:
      base.userDataDir ?? join(appDataPath, clientUserDataDirName(USER_DATA_DIR_NAME, profile)),
    telemetryEnabled: false,
  };
}

/** The window title of a client: `Maestro Client`, or `Maestro Client (work)` for a profile. */
export function clientWindowTitle(profile: string | null): string {
  return profile === null ? `${PRODUCT_NAME} Client` : `${PRODUCT_NAME} Client (${profile})`;
}
