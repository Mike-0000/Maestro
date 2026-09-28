import { deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { RemotePlatformUnsupportedError } from '@core/primitives/ssh/api/remote-platform';
import { RemoteHostProbe } from './host-probe';

describe('RemoteHostProbe', () => {
  it('classifies POSIX before reading and caching the remote home directory', async () => {
    const exec = vi
      .fn<SshClientProxy['exec']>()
      .mockResolvedValueOnce({ stdout: 'Linux\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'Linux\n', stderr: '', exitCode: 0 });
    const execScript = vi
      .fn<SshClientProxy['execScript']>()
      .mockResolvedValue({ stdout: '/home/devuser\n', stderr: '', exitCode: 0 });
    const proxy = { exec, execScript } as Pick<
      SshClientProxy,
      'exec' | 'execScript'
    > as SshClientProxy;
    const ensureProxy = vi.fn(async () => proxy);
    const probe = new RemoteHostProbe('ssh-1', { ensureProxy });

    await expect(probe.probe()).resolves.toEqual({
      platform: 'posix',
      home: '/home/devuser',
    });
    await probe.probe();
    expect(ensureProxy).toHaveBeenCalledWith('ssh-1');
    expect(exec).toHaveBeenCalledOnce();
    expect(execScript).toHaveBeenCalledOnce();

    probe.drop();
    await probe.probe();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(execScript).toHaveBeenCalledTimes(2);
  });

  it('classifies supported Windows hosts through Windows PowerShell', async () => {
    const exec = vi
      .fn<SshClientProxy['exec']>()
      .mockResolvedValue({ stdout: '', stderr: 'uname is not recognized', exitCode: 1 });
    const execScript = vi.fn<SshClientProxy['execScript']>().mockResolvedValue({
      stdout: [
        'emdash-probe=1',
        'language=FullLanguage',
        'home=C:\\Users\\dev',
        'arch=AMD64',
        'os-build=26100',
        'ps-version=5.1.26100.1',
        'git=C:\\Program Files\\Git\\cmd\\git.exe',
      ].join('\r\n'),
      stderr: '',
      exitCode: 0,
    });
    const proxy = { exec, execScript } as Pick<
      SshClientProxy,
      'exec' | 'execScript'
    > as SshClientProxy;
    const probe = new RemoteHostProbe('ssh-1', { ensureProxy: vi.fn(async () => proxy) });

    await expect(probe.probe()).resolves.toEqual({
      platform: 'windows',
      home: 'C:\\Users\\dev',
      architecture: 'x64',
    });
    expect(execScript).toHaveBeenCalledWith(
      expect.stringMatching(/^powershell\.exe -NoLogo -NoProfile -NonInteractive /),
      expect.anything()
    );
  });

  it('rejects Windows hosts that fail a blocking requirement', async () => {
    const exec = vi
      .fn<SshClientProxy['exec']>()
      .mockResolvedValue({ stdout: 'MINGW64_NT-10.0\n', stderr: '', exitCode: 0 });
    const execScript = vi.fn<SshClientProxy['execScript']>().mockResolvedValue({
      stdout: 'emdash-probe=1\nlanguage=ConstrainedLanguage\n',
      stderr: '',
      exitCode: 3,
    });
    const proxy = { exec, execScript } as Pick<
      SshClientProxy,
      'exec' | 'execScript'
    > as SshClientProxy;
    const probe = new RemoteHostProbe('ssh-1', { ensureProxy: vi.fn(async () => proxy) });

    const error = await probe.probe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemotePlatformUnsupportedError);
    expect((error as RemotePlatformUnsupportedError).issues).toEqual([
      expect.objectContaining({ code: 'constrained-language' }),
    ]);
  });

  it('does not cache a failed classification', async () => {
    const exec = vi
      .fn<SshClientProxy['exec']>()
      .mockResolvedValue({ stdout: '', stderr: 'uname: not found', exitCode: 127 });
    const execScript = vi
      .fn<SshClientProxy['execScript']>()
      .mockResolvedValue({ stdout: '', stderr: 'powershell.exe: not found', exitCode: 127 });
    const proxy = { exec, execScript } as Pick<
      SshClientProxy,
      'exec' | 'execScript'
    > as SshClientProxy;
    const probe = new RemoteHostProbe('ssh-1', { ensureProxy: vi.fn(async () => proxy) });

    await expect(probe.probe()).rejects.toThrow('Could not identify the remote operating system');
    await expect(probe.probe()).rejects.toThrow('uname: not found');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps the replacement probe cached when a dropped probe fails late', async () => {
    const first = deferred<SshClientProxy>();
    const proxy = {
      exec: vi.fn(async () => ({ stdout: 'Linux', stderr: '', exitCode: 0 })),
      execScript: vi.fn(async () => ({ stdout: '/home/replacement', stderr: '', exitCode: 0 })),
    } as unknown as SshClientProxy;
    const ensureProxy = vi.fn(async () => proxy).mockImplementationOnce(() => first.promise);
    const probe = new RemoteHostProbe('ssh-1', { ensureProxy });
    const stale = probe.probe();
    const rejected = expect(stale).rejects.toThrow('old connection closed');
    probe.drop();
    const replacement = probe.probe();
    await replacement;

    first.reject(new Error('old connection closed'));
    await rejected;

    expect(probe.probe()).toBe(replacement);
    expect(ensureProxy).toHaveBeenCalledTimes(2);
  });
});
