import { shell } from 'electron';

/** What the caller knows about the URL it opens. */
export type ExternalOpenHint = {
  /**
   * The page will send the browser back to this port on this computer's loopback (for example
   * an OAuth redirect to `http://127.0.0.1:<port>/callback`).
   */
  loopbackPort?: number;
};

export type ExternalOpener = (url: string, hint?: ExternalOpenHint) => Promise<void>;

let override: ExternalOpener | undefined;

/**
 * Opens a URL in the browser of the person using this app. That is this computer's browser,
 * unless an attached full-access (owner) client drives this app from another computer, in which
 * case the owner session routes the request to that computer instead.
 */
export function openExternalForUser(url: string, hint?: ExternalOpenHint): Promise<void> {
  return override ? override(url, hint) : shell.openExternal(url);
}

/** Set only by an attached owner session; `undefined` restores the default. */
export function setExternalOpenerOverride(opener: ExternalOpener | undefined): void {
  override = opener;
}
