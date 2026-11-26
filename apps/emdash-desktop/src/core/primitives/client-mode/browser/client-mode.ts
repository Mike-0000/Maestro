import { isClientModeSearch } from '../api/client-mode-search';

let resolved: boolean | undefined;
let testOverride: boolean | undefined;

/**
 * Whether this renderer drives a remote Maestro host. Read once from the page URL, which does
 * not change for the life of the window; false wherever there is no page URL.
 */
export function isClientMode(): boolean {
  if (testOverride !== undefined) return testOverride;
  resolved ??= isClientModeSearch(globalThis.location?.search ?? '');
  return resolved;
}

/** Tests only: force the answer, or pass undefined to read the URL again. */
export function setClientModeForTesting(value: boolean | undefined): void {
  testOverride = value;
  resolved = undefined;
}
