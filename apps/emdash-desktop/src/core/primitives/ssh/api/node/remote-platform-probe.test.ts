import { describe, expect, it, vi } from 'vitest';
import { WINDOWS_PLATFORM_PROBE_SCRIPT } from '../remote-platform';
import {
  execPowerShell,
  probeRemotePlatform,
  RemotePlatformProbeError,
} from './remote-platform-probe';
import type { SshClientProxy, SshExecResult } from './ssh-client-proxy';

const ENCODED_LINE =
  /^powershell\.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ([A-Za-z0-9+/=]+)$/;

function result(stdout: string, exitCode = 0, stderr = ''): SshExecResult {
  return { stdout, stderr, exitCode };
}

function decodeScript(commandLine: string): string {
  const match = ENCODED_LINE.exec(commandLine);
  if (!match?.[1]) throw new Error(`not an encoded PowerShell command: ${commandLine}`);
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

function fakeProxy(uname: SshExecResult, scripts: SshExecResult[]) {
  const exec = vi.fn<SshClientProxy['exec']>().mockResolvedValue(uname);
  const execScript = vi.fn<SshClientProxy['execScript']>();
  for (const script of scripts) execScript.mockResolvedValueOnce(script);
  return { exec, execScript };
}

const WINDOWS_ANSWER = [
  'emdash-probe=1',
  'language=FullLanguage',
  'home=C:\\Users\\dev',
  'arch=AMD64',
  'os-version=10.0.20348.0',
  'os-build=20348',
  'ps-version=5.1.20348.2849',
].join('\n');

describe('probeRemotePlatform', () => {
  it('reads HOME through the POSIX shell after uname answers', async () => {
    const proxy = fakeProxy(result('Linux\n'), [result('/home/dev\n')]);

    await expect(probeRemotePlatform(proxy)).resolves.toEqual({
      os: 'posix',
      kernel: 'Linux',
      home: '/home/dev',
    });
    expect(proxy.exec).toHaveBeenCalledWith(
      { command: 'uname', args: ['-s'] },
      expect.objectContaining({ timeoutMs: 10_000 })
    );
    expect(proxy.execScript).toHaveBeenCalledWith(`printf '%s\\n' "$HOME"`, expect.anything());
  });

  it('asks Windows PowerShell when uname is missing (cmd or PowerShell default shell)', async () => {
    const proxy = fakeProxy(result('', 1, "'uname' is not recognized"), [result(WINDOWS_ANSWER)]);

    await expect(probeRemotePlatform(proxy)).resolves.toMatchObject({
      os: 'windows',
      home: 'C:\\Users\\dev',
      osBuild: 20_348,
    });
    const [commandLine] = proxy.execScript.mock.calls[0] ?? [];
    expect(decodeScript(commandLine ?? '')).toBe(WINDOWS_PLATFORM_PROBE_SCRIPT);
  });

  it('asks Windows PowerShell when the default shell is Git Bash', async () => {
    const proxy = fakeProxy(result('MINGW64_NT-10.0-26100\n'), [result(WINDOWS_ANSWER)]);

    await expect(probeRemotePlatform(proxy)).resolves.toMatchObject({ os: 'windows' });
    expect(proxy.execScript).toHaveBeenCalledOnce();
  });

  it('reports constrained language mode as a Windows answer', async () => {
    const proxy = fakeProxy(result('', 1), [
      result('emdash-probe=1\nlanguage=ConstrainedLanguage\n', 3),
    ]);

    await expect(probeRemotePlatform(proxy)).resolves.toEqual({
      os: 'windows',
      languageMode: 'ConstrainedLanguage',
    });
  });

  it('combines both failures when neither platform answers', async () => {
    const proxy = fakeProxy(result('', 127, 'sh: uname: not found'), [
      result('', 127, 'sh: powershell.exe: not found'),
    ]);

    const error = await probeRemotePlatform(proxy).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemotePlatformProbeError);
    expect((error as Error).message).toContain('exit 127: sh: uname: not found');
    expect((error as Error).message).toContain('exit 127: sh: powershell.exe: not found');
    expect((error as Error).message).toContain('Windows 10 1809');
  });

  it('decodes PowerShell CLIXML stderr in the diagnostic', async () => {
    const proxy = fakeProxy(result('', 1), [
      result(
        '',
        1,
        '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Access denied_x000D__x000A_</S></Objs>'
      ),
    ]);

    await expect(probeRemotePlatform(proxy)).rejects.toThrow('exit 1: Access denied');
  });

  it('fails when the POSIX home is empty', async () => {
    const proxy = fakeProxy(result('Linux\n'), [result('\n')]);

    await expect(probeRemotePlatform(proxy)).rejects.toThrow('incomplete response');
  });

  it('forwards the abort signal to every remote command', async () => {
    const controller = new AbortController();
    const proxy = fakeProxy(result('', 1), [result(WINDOWS_ANSWER)]);

    await probeRemotePlatform(proxy, controller.signal);

    expect(proxy.exec.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(proxy.execScript.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});

describe('execPowerShell', () => {
  it('runs an encoded script and decodes stderr', async () => {
    const execScript = vi
      .fn<SshClientProxy['execScript']>()
      .mockResolvedValue(
        result('ok', 1, '#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">boom</S></Objs>')
      );

    await expect(execPowerShell({ execScript }, "Write-Output 'ok'")).resolves.toEqual({
      stdout: 'ok',
      stderr: 'boom',
      exitCode: 1,
    });
    expect(decodeScript(execScript.mock.calls[0]?.[0] ?? '')).toBe("Write-Output 'ok'");
  });
});
