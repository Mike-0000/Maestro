import { describe, expect, it } from 'vitest';
import { decideBrowserSurfaceContent } from './browser-surface-content';

describe('decideBrowserSurfaceContent', () => {
  it('keeps an empty canvas app browser webview mounted under the start page', () => {
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: true,
        showStartPage: true,
        hasLoadError: false,
        keepPageMounted: true,
      })
    ).toEqual({ mountWebview: true, overlay: 'start-page' });
  });

  it('keeps a canvas app browser webview mounted under a load error', () => {
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: true,
        showStartPage: false,
        hasLoadError: true,
        keepPageMounted: true,
      })
    ).toEqual({ mountWebview: true, overlay: 'load-error' });
  });

  it('replaces the webview with the start page or an error in task tabs', () => {
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: true,
        showStartPage: true,
        hasLoadError: false,
        keepPageMounted: false,
      })
    ).toEqual({ mountWebview: false, overlay: 'start-page' });
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: true,
        showStartPage: false,
        hasLoadError: true,
        keepPageMounted: false,
      })
    ).toEqual({ mountWebview: false, overlay: 'load-error' });
  });

  it('shows a page with no overlay, and never mounts before the session is registered', () => {
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: true,
        showStartPage: false,
        hasLoadError: false,
        keepPageMounted: false,
      })
    ).toEqual({ mountWebview: true, overlay: null });
    expect(
      decideBrowserSurfaceContent({
        canMountWebview: false,
        showStartPage: true,
        hasLoadError: false,
        keepPageMounted: true,
      })
    ).toEqual({ mountWebview: false, overlay: 'start-page' });
  });
});
