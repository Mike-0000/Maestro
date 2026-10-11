import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureWslDistro,
  linuxUserName,
  parseSetupOutput,
  repositoryFolderName,
  setUpRepositoryInWsl,
  windowsPathInWsl,
} from './wsl-setup';

describe('names and paths', () => {
  it('maps a Windows drive path to the distro mount', () => {
    expect(windowsPathInWsl('C:\\Github\\chorus')).toBe('/mnt/c/Github/chorus');
    expect(windowsPathInWsl('D:/work/')).toBe('/mnt/d/work');
    expect(windowsPathInWsl('\\\\server\\share\\x')).toBeNull();
    expect(windowsPathInWsl('/home/me/x')).toBeNull();
  });

  it('makes a safe folder name and a valid Linux user name', () => {
    expect(repositoryFolderName('My App (v2)')).toBe('My-App-v2');
    expect(repositoryFolderName('../..')).toBe('repository');
    expect(repositoryFolderName('chorus')).toBe('chorus');
    expect(linuxUserName("'Admin'")).toBe('admin');
    expect(linuxUserName('Jane Doe')).toBe('janedoe');
    expect(linuxUserName('123')).toBe('dev');
  });
});

describe('parseSetupOutput', () => {
  it('reads notes, the path and the reuse flag, and ignores other output', () => {
    expect(
      parseSetupOutput(
        'Cloning…\nnote=Installed tmux in the distro.\r\nreused=1\nnote=a=b\npath=/home/me/emdash/repositories/app\n'
      )
    ).toEqual({
      path: '/home/me/emdash/repositories/app',
      reused: true,
      notes: ['Installed tmux in the distro.', 'a=b'],
      error: null,
    });
    expect(parseSetupOutput('error=git is not installed\n')).toMatchObject({
      path: null,
      error: 'git is not installed',
    });
    // A path that is not absolute is not believed.
    expect(parseSetupOutput('path=relative\n').path).toBeNull();
  });
});

describe('ensureWslDistro', () => {
  const none = async () => [];
  it('uses the distro that is there, the default first', async () => {
    const listDistros = async () => [
      { name: 'Ubuntu', isDefault: true },
      { name: 'Debian', isDefault: false },
    ];
    const run = async () => {
      throw new Error('nothing should run');
    };
    expect(await ensureWslDistro(undefined, { listDistros, run })).toEqual({
      distro: 'Ubuntu',
      installed: false,
    });
    expect(await ensureWslDistro('debian', { listDistros, run })).toMatchObject({
      distro: 'Debian',
    });
    await expect(ensureWslDistro('Arch', { listDistros, run })).rejects.toThrow('Arch');
  });

  it('installs Ubuntu with a user named after the Windows user when there is none', async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return '';
    };
    const result = await ensureWslDistro(undefined, {
      listDistros: none,
      run,
      username: "'Admin'",
      env: { SystemRoot: 'C:\\Windows' },
    });
    expect(result).toEqual({ distro: 'Ubuntu', installed: true });
    expect(calls[0]).toEqual(['--install', '-d', 'Ubuntu', '--no-launch']);
    expect(calls[1]?.slice(0, 4)).toEqual(['-d', 'Ubuntu', '-u', 'root']);
    expect(calls[1]?.at(-1)).toContain('useradd -m -s /bin/bash -G sudo admin');
    expect(calls[2]).toEqual(['--terminate', 'Ubuntu']);
  });

  it('says how to finish when WSL itself is not enabled', async () => {
    const run = async () => {
      throw new Error('WSL is not installed');
    };
    await expect(ensureWslDistro(undefined, { listDistros: none, run })).rejects.toThrow(
      /wsl --install/
    );
  });
});

// Against a real distro: EMDASH_TEST_WSL_DISTRO=Ubuntu. Copies a small repository made for the
// test into the distro, twice, and removes the copy afterwards.
const distro = process.env.EMDASH_TEST_WSL_DISTRO;

describe.runIf(process.platform === 'win32' && Boolean(distro))('a real distro', () => {
  it('copies a repository into the distro, sets its remote, and keeps the copy on a second run', async () => {
    const directory = mkdtempSync(join(tmpdir(), "emdash wsl 'setup' "));
    const name = `emdash-setup-test-${Date.now()}`;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, windowsHide: true }).toString().trim();
    const inDistro = (line: string) =>
      execFileSync('wsl.exe', ['-d', distro ?? '', '--cd', '~', '--exec', '/bin/sh', '-c', line], {
        windowsHide: true,
      })
        .toString()
        .trim();
    try {
      git('init', '-q', '-b', 'main');
      writeFileSync(join(directory, 'hello.txt'), 'hello\n');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
      git('remote', 'add', 'origin', 'https://example.com/acme/app.git');
      writeFileSync(join(directory, 'uncommitted.txt'), 'not copied\n');

      const first = await setUpRepositoryInWsl({ windowsPath: directory, name, distro });
      expect(first.reused).toBe(false);
      expect(first.path).toMatch(new RegExp(`^/home/[^/]+/emdash/repositories/${name}$`));
      expect(inDistro(`cat ${first.path}/hello.txt`)).toBe('hello');
      expect(inDistro(`git -C ${first.path} remote get-url origin`)).toBe(
        'https://example.com/acme/app.git'
      );
      expect(inDistro(`ls ${first.path}`)).not.toContain('uncommitted.txt');
      expect(first.notes.join(' ')).toContain('Uncommitted changes stay');

      const second = await setUpRepositoryInWsl({ windowsPath: directory, name, distro });
      expect(second.reused).toBe(true);
      expect(second.path).toBe(first.path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      inDistro(`rm -rf "$HOME/emdash/repositories/${name}"`);
    }
  }, 300_000);
});
