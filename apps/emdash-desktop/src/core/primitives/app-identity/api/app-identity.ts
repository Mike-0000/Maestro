type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

// Preserve the app ID and profile paths so existing installs retain their data during the rename.
export const APP_ID = isCanary ? 'dev.chorus.canary' : 'dev.chorus.app';
export const PRODUCT_NAME = isCanary ? 'Maestro Canary' : 'Maestro';
export const APP_NAME_LOWER = isCanary ? 'maestro-canary' : 'maestro';
export const LINUX_DESKTOP_ID = isCanary ? 'maestro-canary' : 'Maestro';
// Keep these paths stable: changing them would make existing projects, settings, and API keys appear lost.
export const USER_DATA_DIR_NAME = isDev ? 'chorus-dev' : isCanary ? 'chorus-canary' : 'chorus';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'maestro-canary' : 'maestro';
// No Maestro update feed exists yet; the updater stays off until one does.
export const R2_BASE_URL = 'https://releases.chorus.invalid';
export const UPDATES_ENABLED = false;
export const IS_CANARY = isCanary;
