import { HoldToTalkMachine } from '../api/hold-to-talk';
import type { VoiceStore } from './voice-store';

/** The key held to talk. Right Ctrl rarely conflicts with terminal or editor shortcuts. */
export const HOLD_TO_TALK_CODE = 'ControlRight';

/**
 * The in-app talk key, with the same presses as the system-wide one: hold Right Ctrl to speak a
 * command (add Shift to type into the focused agent instead), tap twice to keep listening without
 * holding, and tap once to dictate to the open agent. Esc cancels. Returns an uninstaller.
 */
export function installPushToTalk(store: VoiceStore, target: Window = window): () => void {
  /** The key is physically down. */
  let held = false;
  /** A capture this key started is open. */
  let listening = false;

  const machine = new HoldToTalkMachine((output) => {
    if (output.type === 'tap') {
      store.tap();
    } else if (output.type === 'start') {
      listening = true;
      void store.startListening('hold', output.intent);
    } else {
      listening = false;
      if (output.type === 'cancel') store.cancelListening();
      else if (store.mode === 'hold') void store.stopListening();
    }
  });

  const forget = () => {
    machine.reset();
    listening = false;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === HOLD_TO_TALK_CODE) {
      if (event.repeat || held) return;
      held = true;
      // The capture ended some other way (Send, Esc, a pause, the system-wide key).
      if (listening && !store.isListening) forget();
      machine.talkDown(event.shiftKey);
      return;
    }
    if (event.key === 'Escape' && store.isListening) {
      event.preventDefault();
      event.stopPropagation();
      forget();
      store.cancelListening();
      return;
    }
    // Any other key before listening starts is a chord (e.g. RightCtrl+C): never record it. Once
    // listening, other keys are left alone.
    if (!listening) machine.otherDown(event.key === 'Shift');
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== HOLD_TO_TALK_CODE) return;
    held = false;
    machine.talkUp();
  };

  const onBlur = () => {
    // Losing focus mid-hold would otherwise leave the mic recording until the next keyup. A
    // capture latched by a double tap has no key down and keeps going.
    if (!held) return;
    held = false;
    const wasListening = listening;
    forget();
    if (wasListening && store.mode === 'hold') void store.stopListening();
  };

  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('blur', onBlur);
  return () => {
    machine.reset();
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    target.removeEventListener('blur', onBlur);
  };
}
