import type { VoiceStore } from './voice-store';

/** The key held to talk. Right Ctrl rarely conflicts with terminal or editor shortcuts. */
export const HOLD_TO_TALK_CODE = 'ControlRight';
/** Holding the key this long without pressing another key starts listening (so chords pass). */
const HOLD_DELAY_MS = 180;

/**
 * In-app hold-to-talk: hold Right Ctrl to speak a command; add Shift to dictate into the focused
 * agent instead. Esc cancels. Returns an uninstaller.
 */
export function installPushToTalk(store: VoiceStore, target: Window = window): () => void {
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holding = false;

  const clearHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === HOLD_TO_TALK_CODE) {
      if (event.repeat || holding || holdTimer) return;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holding = true;
        void store.startListening('hold', event.shiftKey ? 'dictation' : 'command');
      }, HOLD_DELAY_MS);
      return;
    }
    if (event.key === 'Escape' && store.isListening) {
      event.preventDefault();
      event.stopPropagation();
      clearHold();
      holding = false;
      store.cancelListening();
      return;
    }
    // Any other key while the hold key is down is a chord (e.g. RightCtrl+C): never record it.
    if (holdTimer && event.key !== 'Shift') clearHold();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== HOLD_TO_TALK_CODE) return;
    // Released before the hold delay: a tap, which answers whatever is waiting for a reply.
    const tapped = holdTimer !== null;
    clearHold();
    if (tapped) store.tap();
    if (holding) {
      holding = false;
      if (store.mode === 'hold') void store.stopListening();
    }
  };

  const onBlur = () => {
    // Losing focus mid-hold would otherwise leave the mic recording until the next keyup.
    clearHold();
    if (holding && store.mode === 'hold') void store.stopListening();
    holding = false;
  };

  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('blur', onBlur);
  return () => {
    clearHold();
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    target.removeEventListener('blur', onBlur);
  };
}
