import { canvasStoreToken } from '@core/features/canvas/contributions/browser/app-stores';
import { voiceStoreToken } from '@core/features/voice/contributions/browser/app-stores';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { ConductorStore } from '../../browser/conductor-store';
import { startRemoteVoiceBridge } from '../../browser/remote-voice-bridge';

const conductorStoreToken = scopedStoreToken<ConductorStore>('conductor');

let stopRemoteVoiceBridge: (() => void) | undefined;

// Resolves the canvas and voice stores at create time; register after both.
export const conductorAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: conductorStoreToken,
    create: (_context, stores) => {
      const canvas = stores.get(canvasStoreToken);
      const conductor = new ConductorStore(canvas, stores.get(voiceStoreToken));
      // Paired devices drive this conductor too; the bridge lives as long as the store.
      stopRemoteVoiceBridge?.();
      stopRemoteVoiceBridge = startRemoteVoiceBridge(conductor, canvas);
      return conductor;
    },
    activate: (store) => store.activate(),
    dispose: (store) => {
      stopRemoteVoiceBridge?.();
      stopRemoteVoiceBridge = undefined;
      store.dispose();
    },
  }),
];

/** Returns the app-scoped ConductorStore. */
export function getConductorStore(): ConductorStore {
  return getAppStores().get(conductorStoreToken);
}
