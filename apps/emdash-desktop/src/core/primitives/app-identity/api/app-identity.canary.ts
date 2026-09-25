// Inlined rather than re-exported from ./app-identity so this module has no relative
// imports. It is loaded under Node (--experimental-strip-types) by
// electron-builder.canary.config.ts, where extensionless ESM specifiers do not resolve.
// Keep in sync with R2_BASE_URL in ./app-identity.ts.
export const R2_BASE_URL = 'https://releases.chorus.invalid';

export const APP_ID = 'dev.chorus.canary';
export const PRODUCT_NAME = 'Chorus Canary';
export const APP_NAME_LOWER = 'chorus-canary';
export const LINUX_DESKTOP_ID = 'chorus-canary';
export const UPDATE_CHANNEL = 'v1-canary';
export const ARTIFACT_PREFIX = 'chorus-canary';
