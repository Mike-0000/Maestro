type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

// Chorus is a fork of Emdash (Apache-2.0). Its identity is distinct so it never shares a
// profile, protocol origin, or update feed with an installed Emdash.
export const APP_ID = isCanary ? 'dev.chorus.canary' : 'dev.chorus.app';
export const PRODUCT_NAME = isCanary ? 'Chorus Canary' : 'Chorus';
export const APP_NAME_LOWER = isCanary ? 'chorus-canary' : 'chorus';
export const LINUX_DESKTOP_ID = isCanary ? 'chorus-canary' : 'Chorus';
// Never rename: a new directory name starts an empty profile (projects, settings, API keys).
export const USER_DATA_DIR_NAME = isDev ? 'chorus-dev' : isCanary ? 'chorus-canary' : 'chorus';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'chorus-canary' : 'chorus';
// No Chorus update feed exists yet; the updater stays off until one does.
export const R2_BASE_URL = 'https://releases.chorus.invalid';
export const UPDATES_ENABLED = false;
export const IS_CANARY = isCanary;
