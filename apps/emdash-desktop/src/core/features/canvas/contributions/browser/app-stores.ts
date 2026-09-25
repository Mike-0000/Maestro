import { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { projectManagerStoreToken } from '@core/features/projects/contributions/app-store-tokens';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';

export const canvasStoreToken = scopedStoreToken<CanvasStore>('canvas.board');

// Resolves the projects store at create time; register after the projects contribution.
export const canvasAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: canvasStoreToken,
    create: (_context, stores) => new CanvasStore(stores.get(projectManagerStoreToken)),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped CanvasStore. */
export function getCanvasStore(): CanvasStore {
  return getAppStores().get(canvasStoreToken);
}
