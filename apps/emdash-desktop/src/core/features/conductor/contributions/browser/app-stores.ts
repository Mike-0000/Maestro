import { canvasStoreToken } from '@core/features/canvas/contributions/browser/app-stores';
import { voiceStoreToken } from '@core/features/voice/contributions/browser/app-stores';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { ConductorStore } from '../../browser/conductor-store';

const conductorStoreToken = scopedStoreToken<ConductorStore>('conductor');

// Resolves the canvas and voice stores at create time; register after both.
export const conductorAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: conductorStoreToken,
    create: (_context, stores) =>
      new ConductorStore(stores.get(canvasStoreToken), stores.get(voiceStoreToken)),
    activate: (store) => store.activate(),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped ConductorStore. */
export function getConductorStore(): ConductorStore {
  return getAppStores().get(conductorStoreToken);
}
