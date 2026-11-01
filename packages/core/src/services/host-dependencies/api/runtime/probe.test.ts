import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '#primitives/exec/api';
import { probeCommandPaths, probeHostElevation, resolveCommandPath } from './probe';

describe('PATH lookup on Windows', () => {
  it('uses the in-process lookup and starts nothing', async () => {
    const exec = createExec();
    exec.findOnPath = vi.fn(async () => ['C:\\bin\\git.exe', 'C:\\other\\git.exe']);

    await expect(probeCommandPaths('git', exec, 'windows')).resolves.toEqual({
      ok: true,
      paths: ['C:\\bin\\git.exe', 'C:\\other\\git.exe'],
    });
    await expect(resolveCommandPath('git', exec, 'windows')).resolves.toBe('C:\\bin\\git.exe');
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('reports a binary that is not on PATH as found nowhere, not as a failed probe', async () => {
    const exec = createExec();
    exec.findOnPath = vi.fn(async () => []);

    await expect(probeCommandPaths('git', exec, 'windows')).resolves.toEqual({
      ok: true,
      paths: [],
    });
    await expect(resolveCommandPath('git', exec, 'windows')).resolves.toBeNull();
  });

  it('reports a lookup that threw as a failed probe', async () => {
    const exec = createExec();
    exec.findOnPath = vi.fn(async () => {
      throw new Error('no environment');
    });

    await expect(probeCommandPaths('git', exec, 'windows')).resolves.toEqual({
      ok: false,
      message: 'no environment',
    });
  });

  it('falls back to where for a context without one', async () => {
    const exec = createExec();
    vi.mocked(exec.exec).mockResolvedValueOnce({ stdout: 'C:\\bin\\git.exe\r\n', stderr: '' });

    await expect(probeCommandPaths('git', exec, 'windows')).resolves.toEqual({
      ok: true,
      paths: ['C:\\bin\\git.exe'],
    });
    expect(exec.exec).toHaveBeenCalledWith('where', ['git'], expect.anything());
  });

  it('never uses it for a POSIX lookup', async () => {
    const exec = createExec();
    exec.findOnPath = vi.fn(async () => []);
    vi.mocked(exec.exec).mockResolvedValueOnce({ stdout: '/usr/bin/git\n', stderr: '' });

    await expect(probeCommandPaths('git', exec, 'linux')).resolves.toEqual({
      ok: true,
      paths: ['/usr/bin/git'],
    });
    expect(exec.findOnPath).not.toHaveBeenCalled();
  });
});

describe('probeHostElevation', () => {
  it('returns null on windows without probing', async () => {
    const exec = createExec();
    await expect(probeHostElevation(exec, 'win32')).resolves.toBeNull();
    expect(exec.exec).not.toHaveBeenCalled();
  });

  it('returns root when the process is root', async () => {
    const exec = createExec({ uid: '0' });
    await expect(probeHostElevation(exec, 'linux')).resolves.toBe('root');
  });

  it('returns passwordless-sudo when passwordless sudo works', async () => {
    const exec = createExec({ uid: '1000', sudo: true });
    await expect(probeHostElevation(exec, 'linux')).resolves.toBe('passwordless-sudo');
  });

  it('returns unavailable when sudo is missing', async () => {
    const exec = createExec({ uid: '1000', sudo: false });
    await expect(probeHostElevation(exec, 'linux')).resolves.toBe('unavailable');
  });

  it('returns unavailable when sudo requires a password', async () => {
    const exec = createExec({ uid: '1000', sudo: 'password' });
    await expect(probeHostElevation(exec, 'darwin')).resolves.toBe('unavailable');
  });
});

function createExec(
  options: { uid?: string; sudo?: boolean | 'password' } = {}
): IExecutionContext {
  return {
    root: '',
    supportsLocalSpawn: true,
    exec: vi.fn(async (command, args = []) => {
      if (command === 'id' && args[0] === '-u') {
        return { stdout: `${options.uid ?? '1000'}\n`, stderr: '' };
      }
      if (command === 'which' && args[0] === 'sudo') {
        if (options.sudo === false) throw new Error('not found');
        return { stdout: '/usr/bin/sudo\n', stderr: '' };
      }
      if (
        (command === '/usr/bin/sudo' || command === 'sudo') &&
        args[0] === '-n' &&
        args[1] === 'true'
      ) {
        if (options.sudo === 'password' || options.sudo === false) {
          throw new Error('sudo: a password is required');
        }
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(' ')}`);
    }),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  };
}
