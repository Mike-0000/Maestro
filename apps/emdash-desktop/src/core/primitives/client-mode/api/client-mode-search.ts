/**
 * The query parameter the client-mode main process adds to the renderer URL. A window loaded
 * the usual way never carries it, so every client-mode branch stays off in the local app.
 */
export const CLIENT_MODE_SEARCH_PARAM = 'maestroClient';

/** The exact search string the client-mode main process loads the renderer with. */
export const CLIENT_MODE_RENDERER_SEARCH = `?${CLIENT_MODE_SEARCH_PARAM}=1`;

/** True only for `maestroClient=1`; any other value, or none, is the local app. */
export function isClientModeSearch(search: string): boolean {
  return new URLSearchParams(search).get(CLIENT_MODE_SEARCH_PARAM) === '1';
}
