import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { installPushToTalk } from '../../browser/push-to-talk';
import { VoiceStore } from '../../browser/voice-store';

export const voiceStoreToken = scopedStoreToken<VoiceStore>('voice');

let uninstallPushToTalk: (() => void) | null = null;

export const voiceAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: voiceStoreToken,
    create: () => new VoiceStore(),
    activate: (store) => {
      store.activate();
      uninstallPushToTalk = installPushToTalk(store, window);
    },
    dispose: (store) => {
      uninstallPushToTalk?.();
      uninstallPushToTalk = null;
      store.dispose();
    },
  }),
];

/** Returns the app-scoped VoiceStore. */
export function getVoiceStore(): VoiceStore {
  return getAppStores().get(voiceStoreToken);
}
