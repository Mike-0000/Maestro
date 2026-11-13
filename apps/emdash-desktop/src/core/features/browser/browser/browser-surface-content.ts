/** App-drawn content that covers a browser surface's page area. */
export type BrowserSurfaceOverlay = 'load-error' | 'start-page' | null;

/**
 * What a browser surface's page area shows. The start page and load errors are drawn by the app,
 * not by the guest page. In a task tab they replace the webview. Canvas app browsers pass
 * `keepPageMounted`, which keeps the webview mounted under them instead: main can only see and
 * drive a guest whose webview is attached, and an agent's app browser often opens empty, before
 * its dev server runs.
 */
export function decideBrowserSurfaceContent(input: {
  /** The session has a webview mount and main registered its partition. */
  canMountWebview: boolean;
  showStartPage: boolean;
  hasLoadError: boolean;
  keepPageMounted: boolean;
}): { mountWebview: boolean; overlay: BrowserSurfaceOverlay } {
  const overlay: BrowserSurfaceOverlay = input.hasLoadError
    ? 'load-error'
    : input.showStartPage
      ? 'start-page'
      : null;
  return {
    mountWebview: input.canMountWebview && (input.keepPageMounted || overlay === null),
    overlay,
  };
}
