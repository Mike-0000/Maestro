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
// Legacy placeholder feed; stays unresolvable so no build can reach the old emdash/R2 feeds.
export const R2_BASE_URL = 'https://releases.chorus.invalid';
// Maestro auto-update feed (see docs/chorus/auto-update.md). Both values are public. The feed is
// the HTTPS URL of the Azure Blob container or folder holding `${UPDATE_CHANNEL}.yml`; append a
// read-only SAS query only for a private container. Each key is an Ed25519 public key (SPKI DER,
// base64) from `pnpm run updates:keygen`; the app installs only manifests signed by one of them.
// Updates stay off until both are set.
export const UPDATE_FEED_URL: string | null =
  'https://stmaestroupdd5313e.blob.core.windows.net/maestro';
export const UPDATE_SIGNING_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAatYv/vhpWohqiMXBPPOFz2oYjDRJayvj1ZbJhgxLZNM=', // key id de5cb049b44e0171
];
export const UPDATES_ENABLED =
  !isCanary && UPDATE_FEED_URL !== null && UPDATE_SIGNING_PUBLIC_KEYS.length > 0;
export const IS_CANARY = isCanary;
