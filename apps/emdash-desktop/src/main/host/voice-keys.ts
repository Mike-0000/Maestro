import { globalShortcut } from 'electron';
import { uIOhook } from 'uiohook-napi';
import type { GlobalVoiceKeyPorts } from '@core/features/voice/node/global-voice-keys';

/**
 * The OS mechanisms behind the global talk keys of the computer this process runs on: Electron's
 * `globalShortcut` for toggle-to-talk and the libuiohook system hook for hold-to-talk. Shared by
 * the local app's host services and the client-mode window, which runs its own talk keys.
 */
export function createVoiceKeyPorts(): GlobalVoiceKeyPorts {
  return {
    globalShortcuts: {
      register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    keyboardHook: {
      start: (onKey) => {
        try {
          uIOhook.removeAllListeners('keydown');
          uIOhook.removeAllListeners('keyup');
          uIOhook.on('keydown', (event) => onKey({ type: 'down', keycode: event.keycode }));
          uIOhook.on('keyup', (event) => onKey({ type: 'up', keycode: event.keycode }));
          uIOhook.start();
          return true;
        } catch {
          return false;
        }
      },
      stop: () => {
        try {
          uIOhook.stop();
        } catch {
          // Already stopped.
        }
        uIOhook.removeAllListeners('keydown');
        uIOhook.removeAllListeners('keyup');
      },
    },
  };
}
