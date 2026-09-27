import { dirname, join } from 'node:path';
import { app, globalShortcut, shell } from 'electron';
import { uIOhook } from 'uiohook-napi';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';

/** Electron-backed host services for the Chorus voice and conductor slices. */
export function createChorusHostServices(): ChorusHostServices {
  return {
    secrets: encryptedAppSecretsStore,
    dataDir: join(app.getPath('userData'), 'chorus'),
    delivery: {
      installRoot:
        app.isPackaged && process.platform === 'win32' ? dirname(process.execPath) : null,
      installWorkerPath:
        app.isPackaged && process.platform === 'win32'
          ? join(process.resourcesPath, 'chorus-delivery', 'install-chorus-update.ps1')
          : null,
      profileRoot: app.getPath('userData'),
    },
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
    openMicrophoneSettings: async () => {
      const url =
        process.platform === 'win32'
          ? 'ms-settings:privacy-microphone'
          : process.platform === 'darwin'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
            : null;
      if (url) await shell.openExternal(url);
    },
  };
}
