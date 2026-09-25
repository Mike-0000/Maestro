import { CanvasBrowserHost } from '@core/features/canvas/api/browser/stores/canvas-browser-host';
import { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { projectManagerStoreToken } from '@core/features/projects/contributions/app-store-tokens';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

export const canvasStoreToken = scopedStoreToken<CanvasStore>('canvas.board');
export const canvasBrowserHostToken = scopedStoreToken<CanvasBrowserHost>('canvas.browsers');

// Resolves the projects store at create time; register after the projects contribution.
export const canvasAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: canvasStoreToken,
    create: (_context, stores) => new CanvasStore(stores.get(projectManagerStoreToken)),
    dispose: (store) => store.dispose(),
  }),
  contributeScopedStore({
    token: canvasBrowserHostToken,
    create: (_context, stores) => {
      const host = new CanvasBrowserHost(stores.get(canvasStoreToken));
      host.start();
      return host;
    },
    dispose: (host) => host.dispose(),
  }),
];

/** Returns the app-scoped CanvasStore. */
export function getCanvasStore(): CanvasStore {
  return getAppStores().get(canvasStoreToken);
}

/** Returns the app-scoped owner of the canvas's app browsers. */
export function getCanvasBrowserHost(): CanvasBrowserHost {
  return getAppStores().get(canvasBrowserHostToken);
}
