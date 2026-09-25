import { join } from 'node:path';
import { app, globalShortcut } from 'electron';
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
  };
}
