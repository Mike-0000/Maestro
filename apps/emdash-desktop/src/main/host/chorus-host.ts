import { join } from 'node:path';
import { app, globalShortcut, shell } from 'electron';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';

/** Electron-backed host services for the Chorus voice and conductor slices. */
export function createChorusHostServices(): ChorusHostServices {
  return {
    secrets: encryptedAppSecretsStore,
    dataDir: join(app.getPath('userData'), 'chorus'),
    globalShortcuts: {
      register: (accelerator, onPress) => globalShortcut.register(accelerator, onPress),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
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
