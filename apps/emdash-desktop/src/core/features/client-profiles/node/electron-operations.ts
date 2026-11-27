import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { app } from 'electron';
import { USER_DATA_DIR_NAME } from '@core/primitives/app-identity/api/app-identity';
import {
  createClientProfilesOperations,
  type ClientProfilesOperations,
  type SpawnProcess,
} from './client-profiles';

const spawnDetached: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

/** The local app's client-profile operations: this computer's appData and this executable. */
export function createElectronClientProfilesOperations(): ClientProfilesOperations {
  return createClientProfilesOperations(() => ({
    appDataDir: app.getPath('appData'),
    baseName: USER_DATA_DIR_NAME,
    execPath: process.execPath,
    appPath: app.isPackaged ? null : app.getAppPath(),
    env: process.env,
    fs: {
      readdir: (path) => readdir(path, { withFileTypes: true }),
      readFile: (path) => readFile(path, 'utf8'),
      mkdir: async (path) => {
        await mkdir(path);
      },
    },
    spawn: spawnDetached,
  }));
}
