import { when } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';

/** Focus a new agent once its task and conversation have appeared in the canvas store. */
export function focusSpawnedAgent(canvas: CanvasStore, conversationId: string): () => void {
  return when(
    () => canvas.agentEntries.some((entry) => entry.conversationId === conversationId),
    () => {
      const entry = canvas.agentEntries.find(
        (candidate) => candidate.conversationId === conversationId
      );
      if (!entry) return;
      canvas.ensureLayout();
      canvas.revealConversation(entry);
      canvas.requestFocus(entry.tileId);
    }
  );
}
