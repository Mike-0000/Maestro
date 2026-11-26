import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { ClientSessionError } from '@core/features/client-mode/api/client-session-contract';

// "Create shortcut": a Desktop and Start Menu shortcut (Windows) that starts this client profile
// with the client switch, so the developer never has to type it again.

export type ShortcutLinkOptions = {
  target: string;
  args: string;
  description: string;
  icon: string;
  iconIndex: number;
  appUserModelId: string;
  cwd?: string;
};

export type ClientShortcutDeps = {
  platform: NodeJS.Platform;
  /** Electron `shell.writeShortcutLink`. */
  writeShortcutLink(
    path: string,
    operation: 'create' | 'replace',
    options: ShortcutLinkOptions
  ): boolean;
  desktopDir: string;
  /** `%APPDATA%`, whose `Microsoft\Windows\Start Menu\Programs` holds per-user shortcuts. */
  appDataDir: string;
  execPath: string;
  /** Set for an unpackaged run, where the executable is Electron and needs the app path. */
  appPath: string | null;
  title: string;
  launchSwitch: string;
  appUserModelId: string;
};

export function createClientShortcuts(deps: ClientShortcutDeps): Result<void, ClientSessionError> {
  if (deps.platform !== 'win32') {
    return err({ type: 'unsupported', message: 'Shortcuts can be created on Windows only.' });
  }
  const args = deps.appPath ? `"${deps.appPath}" ${deps.launchSwitch}` : deps.launchSwitch;
  const fileName = `${deps.title.replace(/[<>:"/\\|?*]/g, '')}.lnk`;
  const targets = [
    join(deps.desktopDir, fileName),
    join(deps.appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', fileName),
  ];
  const failed: string[] = [];
  for (const path of targets) {
    try {
      const written = deps.writeShortcutLink(path, 'create', {
        target: deps.execPath,
        args,
        description: `${deps.title}: drive Maestro on another computer`,
        icon: deps.execPath,
        iconIndex: 0,
        appUserModelId: deps.appUserModelId,
      });
      if (!written) failed.push(path);
    } catch {
      failed.push(path);
    }
  }
  if (failed.length > 0) {
    return err({ type: 'failed', message: `Could not create ${failed.join(' and ')}.` });
  }
  return ok();
}
