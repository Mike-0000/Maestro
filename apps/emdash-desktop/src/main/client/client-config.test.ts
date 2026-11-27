import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { USER_DATA_DIR_NAME } from '@core/primitives/app-identity/api/app-identity';
import { clientLaunchSwitch } from '@core/primitives/client-mode/api/client-profile';
import { buildClientAppConfig, clientWindowTitle } from './client-config';
import { createClientShortcuts } from './shortcut';

describe('client config', () => {
  it('uses its own profile beside the local app and turns telemetry off', () => {
    const config = buildClientAppConfig(null, 'C:\\AppData', {});
    expect(config.userDataDir).toBe(join('C:\\AppData', `${USER_DATA_DIR_NAME}-client`));
    expect(config.telemetryEnabled).toBe(false);
    expect(buildClientAppConfig('work', 'C:\\AppData', {}).userDataDir).toBe(
      join('C:\\AppData', `${USER_DATA_DIR_NAME}-client-work`)
    );
  });

  it('keeps an explicit user data directory', () => {
    const config = buildClientAppConfig(null, 'C:\\AppData', {
      EMDASH_USER_DATA_DIR: 'D:\\scratch\\client',
    });
    expect(config.userDataDir).toBe('D:\\scratch\\client');
  });

  it('names the window and the relaunch switch after the profile', () => {
    expect(clientWindowTitle(null)).toMatch(/ Client$/);
    expect(clientWindowTitle('work')).toMatch(/ Client \(work\)$/);
    expect(clientLaunchSwitch(null)).toBe('--maestro-client');
    expect(clientLaunchSwitch('work')).toBe('--maestro-client=work');
  });
});

describe('client shortcuts', () => {
  const base = {
    desktopDir: 'C:\\Users\\dev\\Desktop',
    appDataDir: 'C:\\Users\\dev\\AppData\\Roaming',
    execPath: 'C:\\Maestro\\Maestro.exe',
    appPath: null,
    title: 'Maestro Client',
    launchSwitch: '--maestro-client',
    appUserModelId: 'app.client',
  };

  it('writes a Desktop and a Start Menu shortcut with the client switch', () => {
    const writeShortcutLink = vi.fn(() => true);
    const result = createClientShortcuts({ ...base, platform: 'win32', writeShortcutLink });
    expect(result.success).toBe(true);
    expect(writeShortcutLink).toHaveBeenCalledTimes(2);
    expect(writeShortcutLink.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      join(base.desktopDir, 'Maestro Client.lnk'),
      join(base.appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Maestro Client.lnk'),
    ]);
    expect((writeShortcutLink.mock.calls[0] as unknown[])[2]).toMatchObject({
      target: base.execPath,
      args: '--maestro-client',
      appUserModelId: 'app.client',
    });
  });

  it('passes the app path for an unpackaged run and refuses other platforms', () => {
    const writeShortcutLink = vi.fn(() => true);
    createClientShortcuts({
      ...base,
      appPath: 'C:\\src\\app',
      platform: 'win32',
      writeShortcutLink,
    });
    expect((writeShortcutLink.mock.calls[0] as unknown[])[2]).toMatchObject({
      args: '"C:\\src\\app" --maestro-client',
    });
    expect(createClientShortcuts({ ...base, platform: 'linux', writeShortcutLink }).success).toBe(
      false
    );
  });
});
