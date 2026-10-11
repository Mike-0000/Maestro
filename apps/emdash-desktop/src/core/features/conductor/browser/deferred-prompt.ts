import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { log } from '@core/primitives/logging/browser/logger';
import { sendToAgent, sendToLiveSession } from './agent-io';
import { entryForConversation } from './roster';

const POLL_MS = 500;
const TIMEOUT_MS = 120_000;
/** TUIs draw their input box a moment after the process starts; typing earlier gets lost. */
const BOOT_GRACE_MS = 3_500;

/**
 * Types a prompt into an agent whose CLI cannot take one at launch, once its session is running.
 * Resolves false when the agent never started.
 */
export async function deliverPromptWhenReady(
  canvas: CanvasStore,
  conversationId: string,
  prompt: string,
  submit = true
): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = entryForConversation(canvas, conversationId);
    if (entry?.sessionActive) {
      await new Promise((resolve) => setTimeout(resolve, BOOT_GRACE_MS));
      const current = entryForConversation(canvas, conversationId) ?? entry;
      try {
        await sendToAgent(current, prompt, submit);
        return true;
      } catch (error) {
        log.warn('conductor: deferred prompt failed', { error, conversationId });
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // The session list can trail the host: before giving up, ask the host itself.
  const entry = entryForConversation(canvas, conversationId);
  if (!entry) return false;
  try {
    return await sendToLiveSession(entry, prompt, submit);
  } catch (error) {
    log.warn('conductor: deferred prompt failed', { error, conversationId });
    return false;
  }
}
