import { describe, expect, it, vi } from 'vitest';
import { createWindowsPathScanner } from './windows-path-scan';

function file(name: string) {
  return { name, isDirectory: () => false };
}

function scanner(
  folders: Record<string, string[]>,
  env: Record<string, string> = { PATH: Object.keys(folders).join(';') }
) {
  const readDir = vi.fn(async (dir: string) => {
    const names = folders[dir];
    if (!names) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return names.map(file);
  });
  return {
    readDir,
    scan: createWindowsPathScanner({ readEnv: async () => env, readDir }),
  };
}

describe('createWindowsPathScanner', () => {
  it('lists matches in PATH order, the bare name before its extensions, as where does', async () => {
    const { scan } = scanner({
      'C:\\npm': ['claude', 'claude.cmd', 'other.exe'],
      'C:\\tools': ['claude.exe'],
    });

    await expect(scan.find('claude')).resolves.toEqual([
      'C:\\npm\\claude',
      'C:\\npm\\claude.cmd',
      'C:\\tools\\claude.exe',
    ]);
  });

  it('matches case-insensitively and reports the name on disk', async () => {
    const { scan } = scanner({ 'C:\\bin': ['Git.EXE'] });

    await expect(scan.find('git')).resolves.toEqual(['C:\\bin\\Git.EXE']);
  });

  it('returns nothing for a command that is not on PATH', async () => {
    const { scan } = scanner({ 'C:\\bin': ['git.exe'] });

    await expect(scan.find('claude')).resolves.toEqual([]);
  });

  it('honours PATHEXT and reads PATH whatever its case', async () => {
    const { scan } = scanner(
      { 'C:\\bin': ['tool.exe', 'tool.ps1'] },
      { Path: 'C:\\bin', PathExt: '.PS1' }
    );

    await expect(scan.find('tool')).resolves.toEqual(['C:\\bin\\tool.ps1']);
  });

  it('skips folders on PATH that match the command name', async () => {
    const readDir = vi.fn(async () => [{ name: 'claude', isDirectory: () => true }]);
    const scan = createWindowsPathScanner({
      readEnv: async () => ({ PATH: 'C:\\bin' }),
      readDir,
    });

    await expect(scan.find('claude')).resolves.toEqual([]);
  });

  it('ignores PATH entries that cannot be read, and tolerates quotes and duplicates', async () => {
    const { scan, readDir } = scanner(
      { 'C:\\bin': ['git.exe'] },
      { PATH: '"C:\\bin";C:\\gone;;c:\\BIN' }
    );

    await expect(scan.find('git')).resolves.toEqual(['C:\\bin\\git.exe']);
    expect(readDir).toHaveBeenCalledTimes(2);
  });

  it('reads each folder once across a pass, and again after clear', async () => {
    const { scan, readDir } = scanner({ 'C:\\bin': ['git.exe'] });

    await scan.find('git');
    await scan.find('rg');
    expect(readDir).toHaveBeenCalledTimes(1);

    scan.clear();
    await scan.find('git');
    expect(readDir).toHaveBeenCalledTimes(2);
  });

  it('reads a folder again once its listing has aged out', async () => {
    let time = 0;
    const readDir = vi.fn(async () => [file('git.exe')]);
    const scan = createWindowsPathScanner({
      readEnv: async () => ({ PATH: 'C:\\bin' }),
      readDir,
      now: () => time,
    });

    await scan.find('git');
    time = 6_000;
    await scan.find('git');

    expect(readDir).toHaveBeenCalledTimes(2);
  });

  it('leaves a folder that does not answer alone for a while', async () => {
    let time = 0;
    const readDir = vi.fn(() => new Promise<never>(() => {}));
    const scan = createWindowsPathScanner({
      readEnv: async () => ({ PATH: 'Z:\\dead' }),
      readDir,
      now: () => time,
      dirTimeoutMs: 1,
    });

    await expect(scan.find('git')).resolves.toEqual([]);
    time = 60_000;
    await expect(scan.find('git')).resolves.toEqual([]);

    expect(readDir).toHaveBeenCalledTimes(1);
  });

  it('refuses a command that is a path', async () => {
    const { scan, readDir } = scanner({ 'C:\\bin': ['git.exe'] });

    await expect(scan.find('..\\git')).resolves.toEqual([]);
    expect(readDir).not.toHaveBeenCalled();
  });
});
