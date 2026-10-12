import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { DictationStore } from '../../browser/dictation-store';
import { installPushToTalk } from '../../browser/push-to-talk';
import { VoiceStore } from '../../browser/voice-store';

export const voiceStoreToken = scopedStoreToken<VoiceStore>('voice');
export const dictationStoreToken = scopedStoreToken<DictationStore>('dictation');

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
  // Resolves the voice store at create time; register after it.
  contributeScopedStore({
    token: dictationStoreToken,
    create: (_context, stores) => {
      const voice = stores.get(voiceStoreToken);
      const dictation = new DictationStore({
        capturing: () => voice.capturing,
        quiet: () => voice.speech.stop(),
      });
      voice.setDictation(dictation);
      return dictation;
    },
    activate: (store) => store.activate(),
    dispose: (store) => store.dispose(),
  }),
];

/** Returns the app-scoped DictationStore. */
export function getDictationStore(): DictationStore {
  return getAppStores().get(dictationStoreToken);
}

/** Returns the app-scoped VoiceStore. */
export function getVoiceStore(): VoiceStore {
  return getAppStores().get(voiceStoreToken);
}
