import { readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  VoiceFocus,
  voiceFocusFileName,
  type VoiceFocusPorts,
} from '@core/features/voice/node/voice-focus';
import { USER_DATA_DIR_NAME } from '@core/primitives/app-identity/api/app-identity';
import { log } from '@main/lib/logger';

let instance: VoiceFocus | null = null;

/** Node and filesystem ports for the shared focus marker. */
export const nodeVoiceFocusPorts: VoiceFocusPorts = {
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  removeFile: (path) => rmSync(path, { force: true }),
  watch: (dir, fileName, onChange) => {
    // The directory, not the file: the file may not exist yet and is removed on quit.
    const watcher = watch(dir, { persistent: false }, (_event, changed) => {
      if (!changed || changed.toString() === fileName) onChange();
    });
    watcher.on('error', (error) => log.warn('voice focus: marker watch failed', { error }));
    return () => watcher.close();
  },
  isPidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  now: () => Date.now(),
};

/**
 * Starts this process's view of which Maestro window owns the global talk keys. `profile` is null
 * for the local app and the client profile slug (`''` for the default client) otherwise. The
 * marker lives in the appData root that every profile's user-data directory shares.
 */
export function startProcessVoiceFocus(profile: string | null): VoiceFocus {
  if (instance) return instance;
  const focus = new VoiceFocus({
    path: join(app.getPath('appData'), voiceFocusFileName(USER_DATA_DIR_NAME)),
    pid: process.pid,
    profile,
    ports: nodeVoiceFocusPorts,
  });
  focus.start();
  const release = () => focus.release();
  app.once('will-quit', release);
  process.once('exit', release);
  instance = focus;
  // Any window of this process (main or a task window) gaining focus takes the keys.
  app.on('browser-window-focus', () => focus.claim());
  // A window focused before this started (window-first boot) has not claimed yet.
  if (BrowserWindow.getFocusedWindow()) focus.claim();
  return focus;
}
