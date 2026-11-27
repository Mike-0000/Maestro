import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, shell } from 'electron';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { startProcessVoiceFocus } from '@main/host/voice-focus';
import { createVoiceKeyPorts } from '@main/host/voice-keys';

/** Electron-backed host services for the Chorus voice and conductor slices. */
export function createChorusHostServices(): ChorusHostServices {
  return {
    secrets: encryptedAppSecretsStore,
    dataDir: join(app.getPath('userData'), 'chorus'),
    delivery: {
      installRoot:
        app.isPackaged && process.platform === 'win32' ? dirname(process.execPath) : null,
      // An installer build (it ships resources/app-update.yml) updates from the Azure feed like
      // every other Maestro client, so the local delivery worker must never swap it in place.
      installWorkerPath:
        app.isPackaged &&
        process.platform === 'win32' &&
        !existsSync(join(process.resourcesPath, 'app-update.yml'))
          ? join(process.resourcesPath, 'chorus-delivery', 'install-chorus-update.ps1')
          : null,
      profileRoot: app.getPath('userData'),
    },
    ...createVoiceKeyPorts(),
    voiceFocus: startProcessVoiceFocus(null),
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
