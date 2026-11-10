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
import { ChatConductorManager } from '../../browser/chat-conductor/manager';
import { ConductorStore } from '../../browser/conductor-store';
import { startRemoteVoiceBridge } from '../../browser/remote-voice-bridge';
import { seedWorkbenchView } from '../../browser/roster';
import { readWorkbenchView } from '../../browser/workbench-view';

export const conductorStoreToken = scopedStoreToken<ConductorStore>('conductor');
export const chatConductorManagerToken = scopedStoreToken<ChatConductorManager>(
  'conductor.chat-conductors'
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
      // Finished dictation goes straight to the agent in front.
      stores.get(dictationStoreToken).setSender((text) => conductor.sendDictation(text));
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
    create: (_context, stores) =>
      new ChatConductorManager(stores.get(canvasStoreToken), stores.get(conductorStoreToken)),
    activate: (manager) => manager.activate(),
    dispose: (manager) => manager.dispose(),
  }),
];

/** Returns the app-scoped manager of the per-chat conductors. */
export function getChatConductorManager(): ChatConductorManager {
  return getAppStores().get(chatConductorManagerToken);
}

/** Returns the app-scoped ConductorStore. */
export function getConductorStore(): ConductorStore {
  return getAppStores().get(conductorStoreToken);
}
