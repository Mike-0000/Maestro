import { describe, expect, it } from 'vitest';
import { clientUserDataDirName, isValidClientProfile, resolveLaunchMode } from './launch-mode';

const DEV = { isPackaged: false };
const PACKAGED = { isPackaged: true };

describe('resolveLaunchMode', () => {
  it('is local for every way the app starts today', () => {
    expect(resolveLaunchMode(['Maestro.exe'], {}, DEV)).toEqual({ mode: 'local' });
    expect(resolveLaunchMode(['electron.exe', '.'], {}, DEV)).toEqual({ mode: 'local' });
    expect(
      resolveLaunchMode(
        ['Maestro.exe', '--enable-logging', 'chorus://open?task=1'],
        {
          PATH: '/usr/bin',
        },
        DEV
      )
    ).toEqual({ mode: 'local' });
    expect(resolveLaunchMode([], {}, DEV)).toEqual({ mode: 'local' });
  });

  it('ignores lookalike switches', () => {
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-clients'], {}, DEV)).toEqual({
      mode: 'local',
    });
    expect(resolveLaunchMode(['Maestro.exe', 'maestro-client'], {}, DEV)).toEqual({
      mode: 'local',
    });
  });

  it('treats an off or empty variable as local', () => {
    for (const value of ['', '0', 'false', 'FALSE', ' 0 ']) {
      expect(resolveLaunchMode(['Maestro.exe'], { MAESTRO_CLIENT: value }, DEV)).toEqual({
        mode: 'local',
      });
    }
  });

  it('starts the default client profile from the switch or the variable', () => {
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-client'], {}, DEV)).toEqual({
      mode: 'client',
      profile: null,
    });
    expect(resolveLaunchMode(['electron.exe', '.'], { MAESTRO_CLIENT: '1' }, DEV)).toEqual({
      mode: 'client',
      profile: null,
    });
    expect(resolveLaunchMode(['electron.exe', '.'], { MAESTRO_CLIENT: 'true' }, DEV)).toEqual({
      mode: 'client',
      profile: null,
    });
  });

  it('reads a named profile and lets the switch win over the variable', () => {
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-client=Work'], {}, DEV)).toEqual({
      mode: 'client',
      profile: 'work',
    });
    expect(resolveLaunchMode(['electron.exe'], { MAESTRO_CLIENT: 'vm-2' }, DEV)).toEqual({
      mode: 'client',
      profile: 'vm-2',
    });
    expect(
      resolveLaunchMode(['Maestro.exe', '--maestro-client=a'], { MAESTRO_CLIENT: 'b' }, DEV)
    ).toEqual({ mode: 'client', profile: 'a' });
  });

  it('falls back to the default profile for a name that is not a slug', () => {
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-client=../x'], {}, DEV)).toEqual({
      mode: 'client',
      profile: null,
    });
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-client='], {}, DEV)).toEqual({
      mode: 'client',
      profile: null,
    });
  });
});

describe('resolveLaunchMode in a packaged build', () => {
  it('ignores MAESTRO_CLIENT, so a stray variable never starts a client', () => {
    for (const value of ['1', 'true', 'work']) {
      expect(resolveLaunchMode(['Maestro.exe'], { MAESTRO_CLIENT: value }, PACKAGED)).toEqual({
        mode: 'local',
      });
    }
  });

  it('still honours the switch', () => {
    expect(resolveLaunchMode(['Maestro.exe', '--maestro-client'], {}, PACKAGED)).toEqual({
      mode: 'client',
      profile: null,
    });
    expect(
      resolveLaunchMode(['Maestro.exe', '--maestro-client=work'], { MAESTRO_CLIENT: '0' }, PACKAGED)
    ).toEqual({ mode: 'client', profile: 'work' });
  });
});

describe('client profile names', () => {
  it('accepts short slugs only', () => {
    expect(isValidClientProfile('work')).toBe(true);
    expect(isValidClientProfile('vm-2')).toBe(true);
    expect(isValidClientProfile('-x')).toBe(false);
    expect(isValidClientProfile('a/b')).toBe(false);
    expect(isValidClientProfile('Work')).toBe(false);
    expect(isValidClientProfile('x'.repeat(33))).toBe(false);
  });

  it('names the user-data directory beside the local one', () => {
    expect(clientUserDataDirName('chorus', null)).toBe('chorus-client');
    expect(clientUserDataDirName('chorus', 'vm-2')).toBe('chorus-client-vm-2');
  });
});
