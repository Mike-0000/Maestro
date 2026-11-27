import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClientLaunch,
  createClientProfilesOperations,
  listClientProfiles,
  parseNewProfileName,
  profileFromDirName,
  readSavedHost,
  type ClientProfilesDeps,
  type SpawnedProcess,
  type SpawnOptions,
} from './client-profiles';

const APP_DATA = join('C:', 'Users', 'me', 'AppData', 'Roaming');

const storedConnection = (url: string, hostName = 'fedora') =>
  JSON.stringify({
    version: 1,
    url,
    hostId: 'host-1',
    hostName,
    deviceId: 'device-1',
    token: 'Y2lwaGVydGV4dA==',
    pairedAt: 1,
  });

type FakeChild = SpawnedProcess & { emit(event: 'spawn' | 'error', error?: Error): void };

function fakeChild(): FakeChild & { unref: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, (error?: Error) => void>();
  return {
    once(event: string, listener: (error?: Error) => void) {
      listeners.set(event, listener);
      return undefined;
    },
    emit(event, error) {
      listeners.get(event)?.(error);
    },
    unref: vi.fn(),
  } as FakeChild & { unref: ReturnType<typeof vi.fn> };
}

function harness(options: {
  dirs?: string[];
  files?: Record<string, string>;
  appPath?: string | null;
  spawnOutcome?: 'spawn' | 'error';
}) {
  const dirs = new Set(options.dirs ?? []);
  const files = options.files ?? {};
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const deps: ClientProfilesDeps = {
    appDataDir: APP_DATA,
    baseName: 'chorus',
    execPath: 'C:\\Maestro\\Maestro.exe',
    appPath: options.appPath ?? null,
    env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', EMDASH_USER_DATA_DIR: 'C:\\scratch' },
    fs: {
      readdir: async () => [
        ...[...dirs].map((name) => ({ name, isDirectory: () => true })),
        { name: 'chorus-client-file.txt', isDirectory: () => false },
      ],
      readFile: async (path) => {
        const text = files[path];
        if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return text;
      },
      mkdir: async (path) => {
        const name = path.slice(APP_DATA.length + 1);
        if (dirs.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        dirs.add(name);
      },
    },
    spawn: (command, args, spawnOptions) => {
      spawned.push({ command, args, options: spawnOptions });
      const child = fakeChild();
      children.push(child);
      queueMicrotask(() =>
        child.emit(
          options.spawnOutcome ?? 'spawn',
          options.spawnOutcome === 'error' ? new Error('ENOENT') : undefined
        )
      );
      return child;
    },
  };
  return { deps, dirs, spawned, children };
}

describe('profileFromDirName', () => {
  it('recognises the default and named profiles of this app only', () => {
    expect(profileFromDirName('chorus', 'chorus-client')).toBeNull();
    expect(profileFromDirName('chorus', 'chorus-client-fedora')).toBe('fedora');
    expect(profileFromDirName('chorus', 'chorus-client-vm-2')).toBe('vm-2');
    expect(profileFromDirName('chorus', 'chorus')).toBeUndefined();
    expect(profileFromDirName('chorus', 'chorus-dev-client')).toBeUndefined();
    expect(profileFromDirName('chorus', 'chorus-canary-client-x')).toBeUndefined();
    expect(profileFromDirName('chorus', 'chorus-client-')).toBeUndefined();
    expect(profileFromDirName('chorus', 'chorus-client-Upper')).toBeUndefined();
    expect(profileFromDirName('chorus', 'chorus-clientx')).toBeUndefined();
    expect(profileFromDirName('chorus-dev', 'chorus-dev-client-a')).toBe('a');
  });
});

describe('readSavedHost', () => {
  it('returns the address and host name, never the credential', () => {
    const host = readSavedHost(storedConnection('https://fedora.tail.ts.net'));
    expect(host).toEqual({ serverUrl: 'https://fedora.tail.ts.net', hostName: 'fedora' });
    expect(JSON.stringify(host)).not.toContain('Y2lwaGVydGV4dA');
  });

  it('ignores unreadable or foreign files', () => {
    expect(readSavedHost('{nope')).toBeNull();
    expect(readSavedHost(JSON.stringify({ version: 2, url: 'x' }))).toBeNull();
    expect(readSavedHost('null')).toBeNull();
  });

  it('treats an empty host name as unknown', () => {
    expect(readSavedHost(storedConnection('https://h', ''))?.hostName).toBeNull();
  });
});

describe('listClientProfiles', () => {
  it('lists the default profile first, with the saved server when there is one', async () => {
    const { deps } = harness({
      dirs: ['chorus', 'chorus-client-zeta', 'chorus-client', 'chorus-client-alpha', 'other'],
      files: {
        [join(APP_DATA, 'chorus-client-zeta', 'client-connection.json')]:
          storedConnection('https://zeta.example'),
        [join(APP_DATA, 'chorus-client-alpha', 'client-connection.json')]: '{broken',
      },
    });
    expect(await listClientProfiles(deps)).toEqual([
      { profile: null, serverUrl: null, hostName: null },
      { profile: 'alpha', serverUrl: null, hostName: null },
      { profile: 'zeta', serverUrl: 'https://zeta.example', hostName: 'fedora' },
    ]);
  });

  it('is empty when appData cannot be read', async () => {
    const { deps } = harness({});
    deps.fs.readdir = async () => {
      throw new Error('EACCES');
    };
    expect(await listClientProfiles(deps)).toEqual([]);
  });
});

describe('buildClientLaunch', () => {
  it('passes only the client switch to a packaged build', () => {
    const launch = buildClientLaunch({
      execPath: 'C:\\Maestro\\Maestro.exe',
      appPath: null,
      profile: null,
      env: { PATH: 'p' },
    });
    expect(launch).toEqual({
      command: 'C:\\Maestro\\Maestro.exe',
      args: ['--maestro-client'],
      env: { PATH: 'p' },
    });
  });

  it('puts the app path first in development and names the profile', () => {
    const launch = buildClientLaunch({
      execPath: 'electron.exe',
      appPath: 'C:\\repo\\apps\\emdash-desktop',
      profile: 'fedora',
      env: {},
    });
    expect(launch.args).toEqual(['C:\\repo\\apps\\emdash-desktop', '--maestro-client=fedora']);
  });

  it('drops variables that would break or redirect the client', () => {
    const env = {
      PATH: 'p',
      ELECTRON_RUN_AS_NODE: '1',
      MAESTRO_CLIENT: 'other',
      EMDASH_USER_DATA_DIR: 'C:\\scratch',
      EMDASH_DB_FILE: 'C:\\db',
    };
    const launch = buildClientLaunch({ execPath: 'x', appPath: null, profile: null, env });
    expect(launch.env).toEqual({ PATH: 'p' });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('parseNewProfileName', () => {
  it('lowercases and trims a valid name', () => {
    expect(parseNewProfileName('  Work-VM ')).toEqual({ success: true, data: 'work-vm' });
  });

  it('rejects empty, reserved and unsafe names', () => {
    for (const name of ['', '   ', 'default', '-x', 'a/b', '..', 'a b', 'x'.repeat(33)]) {
      expect(parseNewProfileName(name).success, name).toBe(false);
    }
  });
});

describe('client profile operations', () => {
  it('adds a profile: creates its directory and starts it detached without a shell', async () => {
    const h = harness({ dirs: ['chorus-client'] });
    const operations = createClientProfilesOperations(() => h.deps);
    const result = await operations.add('Fedora');
    expect(result).toEqual({
      success: true,
      data: { profile: 'fedora', serverUrl: null, hostName: null },
    });
    expect(h.dirs.has('chorus-client-fedora')).toBe(true);
    expect(h.spawned).toEqual([
      {
        command: 'C:\\Maestro\\Maestro.exe',
        args: ['--maestro-client=fedora'],
        options: { detached: true, stdio: 'ignore', env: { PATH: 'x' }, windowsHide: false },
      },
    ]);
    expect(h.children[0]!.unref).toHaveBeenCalled();
  });

  it('refuses a duplicate or invalid name without launching', async () => {
    const h = harness({ dirs: ['chorus-client-fedora'] });
    const operations = createClientProfilesOperations(() => h.deps);
    const duplicate = await operations.add('fedora');
    expect(duplicate.success === false && duplicate.error.type).toBe('exists');
    const invalid = await operations.add('../evil');
    expect(invalid.success === false && invalid.error.type).toBe('invalid');
    expect(h.spawned).toEqual([]);
  });

  it('opens only profiles that exist and validates the name again', async () => {
    const h = harness({ dirs: ['chorus-client', 'chorus-client-fedora'] });
    const operations = createClientProfilesOperations(() => h.deps);
    expect((await operations.open(null)).success).toBe(true);
    expect((await operations.open('fedora')).success).toBe(true);
    const missing = await operations.open('ghost');
    expect(missing.success === false && missing.error.type).toBe('not-found');
    const invalid = await operations.open('--inspect');
    expect(invalid.success === false && invalid.error.type).toBe('invalid');
    expect(h.spawned.map((entry) => entry.args)).toEqual([
      ['--maestro-client'],
      ['--maestro-client=fedora'],
    ]);
  });

  it('reports a failed spawn instead of throwing', async () => {
    const h = harness({ dirs: ['chorus-client'], spawnOutcome: 'error' });
    const operations = createClientProfilesOperations(() => h.deps);
    const result = await operations.open(null);
    expect(result.success === false && result.error.type).toBe('failed');
  });
});
