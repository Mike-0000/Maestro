import type { ClientChannel } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { openChannel } from '../operations/open-channel';
import { LocalShellClient } from './local-shell-client';
import { listWslDistros, parseWslDistroList } from './wsl-distros';

// A WSL2 distro as the machine. The first block needs no distro; the second runs against a
// real one and is skipped unless EMDASH_TEST_WSL_DISTRO names it.

describe('parseWslDistroList', () => {
  it('reads the WSL2 distros, the default first, and leaves out what cannot be a Host', () => {
    const output = [
      '  NAME              STATE           VERSION',
      '  docker-desktop    Running         2',
      '  Debian            Stopped         2',
      '* Ubuntu-24.04      Running         2',
      '  Legacy            Stopped         1',
      '',
    ].join('\r\n');
    expect(parseWslDistroList(output)).toEqual([
      { name: 'Ubuntu-24.04', isDefault: true },
      { name: 'Debian', isDefault: false },
    ]);
    // wsl.exe prints UTF-16; read as bytes it is full of NULs.
    expect(parseWslDistroList(output.split('').join('\0'))).toHaveLength(2);
    expect(parseWslDistroList('')).toEqual([]);
  });
});

describe('LocalShellClient in a distro (spawn arguments)', () => {
  it('hands the command to /bin/sh in the distro as one argument, from the user home', () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const client = new LocalShellClient({
      wsl: { distro: 'Ubuntu' },
      env: { SystemRoot: 'C:\\Windows' },
      spawn: (command, args) => {
        calls.push({ command, args });
        throw new Error('not spawned in this test');
      },
    });
    client.connect();
    return new Promise<void>((resolve) => {
      client.once('ready', () => {
        client.exec(`printf '%s' "a b" 'c"d'`, () => {
          const [call] = calls;
          expect(call?.command).toBe('C:\\Windows\\System32\\wsl.exe');
          expect(call?.args.slice(0, 7)).toEqual([
            '-d',
            'Ubuntu',
            '--cd',
            '~',
            '--exec',
            '/bin/sh',
            '-c',
          ]);
          // One argument: the PATH line, then the caller's command untouched.
          expect(call?.args).toHaveLength(8);
          expect(call?.args[7]).toContain('grep -v "^/mnt/[a-z]/"');
          expect(call?.args[7]?.endsWith(`\nprintf '%s' "a b" 'c"d'`)).toBe(true);
          client.destroy();
          resolve();
        });
      });
    });
  });
});

const distro = process.env.EMDASH_TEST_WSL_DISTRO;

describe.runIf(process.platform === 'win32' && Boolean(distro))('a real distro', () => {
  const clients: LocalShellClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  async function ready(): Promise<LocalShellClient> {
    const client = new LocalShellClient({ wsl: { distro: distro ?? '' } });
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.once('ready', () => resolve());
      client.connect();
    });
    return client;
  }

  function run(client: LocalShellClient, command: string, input?: string) {
    const ssh = client.asSshClient();
    return openChannel(ssh, 'exec', (callback) => {
      ssh.exec(command, callback);
    }).then(
      (channel: ClientChannel) =>
        new Promise<{ stdout: string; code: number }>((resolve) => {
          let stdout = '';
          channel.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
          channel.once('close', (code: number) => resolve({ stdout, code }));
          if (input !== undefined) channel.end(input);
        })
    );
  }

  it('lists the distro', async () => {
    expect((await listWslDistros()).map((entry) => entry.name)).toContain(distro);
  });

  it('runs a command line exactly as written, in Linux, from the user home', async () => {
    const client = await ready();
    const result = await run(
      client,
      `printf '%s|' "a b" 'c"d' "e'f" '$HOME' 'p%PATH%q' 'r&s|t<u>v^w'; echo; uname -s; pwd; exit 7`
    );
    const [line, kernel, cwd] = result.stdout.split('\n');
    expect(line).toBe(`a b|c"d|e'f|$HOME|p%PATH%q|r&s|t<u>v^w|`);
    expect(kernel).toBe('Linux');
    expect(cwd).toMatch(/^\/(home|root)/);
    expect(result.code).toBe(7);
  }, 60_000);

  it('keeps Windows directories off PATH', async () => {
    const client = await ready();
    const result = await run(client, 'printf %s "$PATH"');
    expect(result.stdout).not.toMatch(/\/mnt\/[a-z]\//);
    expect(result.stdout).toContain('/usr/bin');
  }, 60_000);

  it('feeds a script through stdin', async () => {
    const client = await ready();
    const result = await run(client, '/bin/sh -s', 'echo from-stdin\nexit 3\n');
    expect(result.stdout).toBe('from-stdin\n');
    expect(result.code).toBe(3);
  }, 60_000);

  it('reports a socket that is not there as a failed channel, not a hang', async () => {
    const client = await ready();
    const ssh = client.asSshClient();
    const channel = await openChannel(ssh, 'streamlocal', (callback) => {
      ssh.openssh_forwardOutStreamLocal('/tmp/emdash-test/run/missing.sock', callback);
    });
    const code = await new Promise<number>((resolve) => channel.once('close', resolve));
    expect(code).not.toBe(0);
  }, 60_000);
});
