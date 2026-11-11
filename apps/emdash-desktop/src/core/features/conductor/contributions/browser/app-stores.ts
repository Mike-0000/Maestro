import { canvasStoreToken } from '@core/features/canvas/contributions/browser/app-stores';
import {
  dictationStoreToken,
  voiceStoreToken,
} from '@core/features/voice/contributions/browser/app-stores';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { startAgentRequestBridge } from '../../browser/agent-request-bridge';
import { ChatDictationRoute } from '../../browser/chat-conductor/dictation-route';
import { ChatConductorManager } from '../../browser/chat-conductor/manager';
import { ConductorStore } from '../../browser/conductor-store';
import { startRemoteVoiceBridge } from '../../browser/remote-voice-bridge';
import { seedWorkbenchView } from '../../browser/roster';
import { readWorkbenchView } from '../../browser/workbench-view';

export const conductorStoreToken = scopedStoreToken<ConductorStore>('conductor');
export const chatConductorManagerToken = scopedStoreToken<ChatConductorManager>(
  'conductor.chat-conductors'
);
export const chatDictationRouteToken = scopedStoreToken<ChatDictationRoute>(
  'conductor.chat-dictation'
);

let stopRemoteVoiceBridge: (() => void) | undefined;
let stopAgentRequestBridge: (() => void) | undefined;

// Resolves the canvas and voice stores at create time; register after both.
export const conductorAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: conductorStoreToken,
    create: (_context, stores) => {
      const canvas = stores.get(canvasStoreToken);
      // Focus follows the view on screen (canvas, task view, or neither), not the canvas alone.
      seedWorkbenchView(readWorkbenchView);
      const conductor = new ConductorStore(canvas, stores.get(voiceStoreToken));
      // Paired devices drive this conductor too; the bridge lives as long as the store.
      stopRemoteVoiceBridge?.();
      stopRemoteVoiceBridge = startRemoteVoiceBridge(conductor, canvas);
      // Agents on the canvas reach this conductor through their session's MCP tool.
      stopAgentRequestBridge?.();
      stopAgentRequestBridge = startAgentRequestBridge(conductor.requests);
      return conductor;
    },
    activate: (store) => store.activate(),
    dispose: (store) => {
      stopRemoteVoiceBridge?.();
      stopRemoteVoiceBridge = undefined;
      stopAgentRequestBridge?.();
      stopAgentRequestBridge = undefined;
      store.dispose();
    },
  }),
  // Each chat's own conductor. Reads readiness and defaults from the conductor store's status.
  contributeScopedStore({
    token: chatConductorManagerToken,
    create: (_context, stores) => {
      const conductor = stores.get(conductorStoreToken);
      const manager = new ChatConductorManager(stores.get(canvasStoreToken), conductor);
      // The chat conductor in front takes the typed box and voice commands instead of Maestro.
      conductor.setChatConductors(manager);
      return manager;
    },
    activate: (manager) => manager.activate(),
    dispose: (manager) => manager.dispose(),
  }),
  // Finished dictation goes straight to the agent in front, or into the composer of the chat
  // conductor in front.
  contributeScopedStore({
    token: chatDictationRouteToken,
    create: (_context, stores) => {
      const conductor = stores.get(conductorStoreToken);
      return new ChatDictationRoute(
        stores.get(dictationStoreToken),
        stores.get(chatConductorManagerToken),
        (text) => conductor.sendDictation(text)
      );
    },
    activate: (route) => route.activate(),
    dispose: (route) => route.dispose(),
  }),
];

/** Returns the app-scoped route of on-device dictation. */
export function getChatDictationRoute(): ChatDictationRoute {
  return getAppStores().get(chatDictationRouteToken);
}

/** Returns the app-scoped manager of the per-chat conductors. */
export function getChatConductorManager(): ChatConductorManager {
  return getAppStores().get(chatConductorManagerToken);
}

/** Returns the app-scoped ConductorStore. */
export function getConductorStore(): ConductorStore {
  return getAppStores().get(conductorStoreToken);
}
