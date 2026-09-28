import { protocolMajor, PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { describe, expect, it, vi } from 'vitest';
import { windowsWorkspaceServerLayout, workspaceServerLayout } from '../layout';
import {
  buildWindowsWorkspaceServerInstallScripts,
  buildWorkspaceServerChannelPointerCommand,
  buildWorkspaceServerInstallCommand,
  WorkspaceServerInstaller,
} from './installer';

const installBaseUrl = 'http://minio:9000/emdash-releases/workspace-server';

describe('workspace-server installer command', () => {
  it('downloads the immutable hosted script and pins the selected version', () => {
    const command = buildWorkspaceServerInstallCommand(
      "http://minio:9000/emdash artifact's/$(printf injected)",
      '1.2.3-canary.4'
    );

    expect(command).toContain(
      "curl -fsSL --output \"$install_script\" -- 'http://minio:9000/emdash%20artifact'\\''s/$(printf%20injected)/1.2.3-canary.4/install.sh'"
    );
    expect(command).toContain(
      "sh \"$install_script\" --base-url 'http://minio:9000/emdash%20artifact'\\''s/$(printf%20injected)' --version 1.2.3-canary.4"
    );
    expect(command).toContain('if ! curl');
    expect(command).toContain('exit 41');
  });

  it('rejects unsupported install base URL protocols', () => {
    expect(() =>
      buildWorkspaceServerInstallCommand('ftp://releases.example.test', '1.2.3')
    ).toThrow(expect.objectContaining({ code: 'artifact-download-failed' }));
    expect(() =>
      buildWorkspaceServerInstallCommand('file:///opt/emdash-artifacts', '1.2.3')
    ).toThrow(expect.objectContaining({ code: 'artifact-download-failed' }));
  });

  it('builds the stable channel pointer command for the desktop protocol major', () => {
    const command = buildWorkspaceServerChannelPointerCommand(
      'https://releases.example.test/workspace-server',
      'stable',
      protocolMajor()
    );

    expect(command).toContain(
      `curl -fsSL -- https://releases.example.test/workspace-server/channels/stable/protocol-${protocolMajor()}.json`
    );
    expect(command).not.toContain('/channels/canary/');
  });

  it('falls back from the canary pointer to the stable pointer in the remote script', () => {
    const command = buildWorkspaceServerChannelPointerCommand(
      'https://releases.example.test/workspace-server',
      'canary',
      protocolMajor()
    );

    expect(command).toContain(
      `curl -fsSL -- https://releases.example.test/workspace-server/channels/canary/protocol-${protocolMajor()}.json 2>/dev/null || curl -fsSL -- https://releases.example.test/workspace-server/channels/stable/protocol-${protocolMajor()}.json`
    );
    expect(command).toContain(
      `wget -qO- -- https://releases.example.test/workspace-server/channels/canary/protocol-${protocolMajor()}.json 2>/dev/null || wget -qO- -- https://releases.example.test/workspace-server/channels/stable/protocol-${protocolMajor()}.json`
    );
  });

  it('executes a pinned hosted installer through the SSH proxy', async () => {
    const execScript = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: 'versions/0.1.0-dev.abc123\n', stderr: '', exitCode: 0 });
    const ensureProxy = vi.fn(async () => ({ exec, execScript }) as never);
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy },
      baseUrl: installBaseUrl,
    });
    const layout = workspaceServerLayout('/home/devuser');

    await installer.install({
      connectionId: 'ssh-1',
      layout,
      version: '0.1.0-dev.abc123',
    });

    expect(ensureProxy).toHaveBeenCalledWith('ssh-1');
    expect(execScript).toHaveBeenCalledWith(
      expect.stringContaining(`${installBaseUrl}/0.1.0-dev.abc123/install.sh`),
      expect.objectContaining({ timeoutMs: 300_000 })
    );
    expect(execScript.mock.calls[0]?.[0]).toContain('--version 0.1.0-dev.abc123');
    expect(exec).toHaveBeenCalledWith(
      { command: 'readlink', args: ['--', layout.currentLink] },
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it('resolves the channel pointer before installing when no version is provided', async () => {
    const execScript = vi
      .fn()
      .mockResolvedValueOnce({ stdout: pointerBody('0.1.0'), stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const exec = vi.fn().mockResolvedValue({
      stdout: 'versions/0.1.0\n',
      stderr: '',
      exitCode: 0,
    });
    const ensureProxy = vi.fn(async () => ({ exec, execScript }) as never);
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy },
      baseUrl: installBaseUrl,
    });

    await installer.install({
      connectionId: 'ssh-1',
      layout: workspaceServerLayout('/home/devuser'),
    });

    expect(execScript).toHaveBeenCalledTimes(2);
    expect(execScript.mock.calls[0]?.[0]).toContain(
      `${installBaseUrl}/channels/stable/protocol-${protocolMajor()}.json`
    );
    expect(execScript.mock.calls[1]?.[0]).toContain(`${installBaseUrl}/0.1.0/install.sh`);
    expect(execScript.mock.calls[1]?.[0]).toContain('--version 0.1.0');
  });

  it('parses the available version from the channel pointer', async () => {
    const execScript = vi.fn().mockResolvedValue({
      stdout: pointerBody('0.1.0-dev.abc123'),
      stderr: '',
      exitCode: 0,
    });
    const ensureProxy = vi.fn(async () => ({ execScript }) as never);
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy },
      baseUrl: installBaseUrl,
    });

    await expect(installer.availableVersion('ssh-1')).resolves.toBe('0.1.0-dev.abc123');

    expect(ensureProxy).toHaveBeenCalledWith('ssh-1');
    expect(execScript).toHaveBeenCalledWith(
      expect.stringContaining(
        `curl -fsSL -- ${installBaseUrl}/channels/stable/protocol-${protocolMajor()}.json`
      ),
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it('rejects an invalid channel pointer body', async () => {
    const execScript = vi.fn().mockResolvedValue({
      stdout: 'not JSON\n',
      stderr: '',
      exitCode: 0,
    });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
    });

    await expect(installer.availableVersion('ssh-1')).rejects.toMatchObject({
      code: 'artifact-download-failed',
      message: expect.stringContaining('channel pointer is invalid'),
    });
  });

  it('rejects a channel pointer for a different protocol major', async () => {
    const wrongMajor = protocolMajor() + 1;
    const execScript = vi.fn().mockResolvedValue({
      stdout: pointerBody('0.2.0', `${wrongMajor}.0.0`),
      stderr: '',
      exitCode: 0,
    });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
    });

    await expect(installer.availableVersion('ssh-1')).rejects.toMatchObject({
      code: 'artifact-download-failed',
      message: expect.stringContaining(
        `expected protocol major ${protocolMajor()}, received ${wrongMajor}`
      ),
    });
  });

  it('rejects an install that does not select the requested version', async () => {
    const execScript = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const exec = vi.fn().mockResolvedValue({
      stdout: 'versions/1.2.2\n',
      stderr: '',
      exitCode: 0,
    });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ exec, execScript }) as never) },
      baseUrl: installBaseUrl,
    });

    await expect(
      installer.install({
        connectionId: 'ssh-1',
        layout: workspaceServerLayout('/home/devuser'),
        version: '1.2.3',
      })
    ).rejects.toMatchObject({
      code: 'install-failed',
      message: expect.stringContaining('installed 1.2.2 instead of 1.2.3'),
    });
  });

  it.each([
    [40, 'unsupported-platform'],
    [41, 'artifact-download-failed'],
    [42, 'install-failed'],
  ] as const)('maps installer exit %i to %s', async (exitCode, code) => {
    const execScript = vi.fn().mockResolvedValue({ stdout: '', stderr: 'failed', exitCode });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
      baseUrl: 'https://releases.example.test/workspace-server',
    });

    await expect(
      installer.install({
        connectionId: 'ssh-1',
        layout: workspaceServerLayout('/home/devuser'),
        version: '1.2.3',
      })
    ).rejects.toMatchObject({ code });
  });

  it('rejects a current link that points outside the managed versions directory', async () => {
    const exec = vi.fn(async () => ({
      stdout: '/tmp/versions/1.2.3\n',
      stderr: '',
      exitCode: 0,
    }));
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ exec }) as never) },
    });

    await expect(
      installer.installedVersion('ssh-1', workspaceServerLayout('/home/devuser'))
    ).rejects.toMatchObject({
      code: 'install-failed',
      message: expect.stringContaining('points outside versions/'),
    });
  });
});

const ENCODED_LINE =
  /^powershell\.exe -NoLogo -NoProfile -NonInteractive (-ExecutionPolicy Bypass )?-OutputFormat Text -EncodedCommand ([A-Za-z0-9+/=]+)$/;

function decodePowerShell(commandLine: unknown): { script: string; bypass: boolean } {
  const match = ENCODED_LINE.exec(String(commandLine));
  if (!match?.[2]) throw new Error(`not an encoded PowerShell command: ${String(commandLine)}`);
  return {
    script: Buffer.from(match[2], 'base64').toString('utf16le'),
    bypass: match[1] !== undefined,
  };
}

describe('Windows workspace-server installer', () => {
  const layout = windowsWorkspaceServerLayout(String.raw`C:\Users\dev`);
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

  it('downloads install.ps1 to staging, runs it, and verifies the selected version', async () => {
    const execScript = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('1.2.3'));
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
      baseUrl: installBaseUrl,
    });

    await installer.install({ connectionId: 'ssh-1', layout, version: '1.2.3' });

    const download = decodePowerShell(execScript.mock.calls[0]?.[0]);
    const run = decodePowerShell(execScript.mock.calls[1]?.[0]);
    const verify = decodePowerShell(execScript.mock.calls[2]?.[0]);
    expect(download.bypass).toBe(false);
    expect(download.script).toContain(`'${installBaseUrl}/1.2.3/install.ps1'`);
    expect(download.script).toMatch(
      /'C:\\Users\\dev\\\.emdash\\workspace-server\\staging\\install-1\.2\.3-[0-9a-f-]{36}\.ps1'/
    );
    expect(download.script).not.toContain('ScriptBlock');
    expect(run.bypass).toBe(true);
    expect(run.script).toContain(String.raw`-InstallRoot 'C:\Users\dev\.emdash\workspace-server'`);
    expect(run.script).toContain(`-BaseUrl '${installBaseUrl}' -Version '1.2.3'`);
    expect(run.script).not.toContain('DownloadString');
    expect(verify.script).toContain(String.raw`C:\Users\dev\.emdash\workspace-server\current`);
    expect(execScript.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 300_000 });
  });

  it('does not run the installer when its download fails', async () => {
    const execScript = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'Could not download x: 404', exitCode: 41 });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
      baseUrl: installBaseUrl,
    });

    await expect(
      installer.install({ connectionId: 'ssh-1', layout, version: '1.2.3' })
    ).rejects.toMatchObject({
      code: 'artifact-download-failed',
      message: 'Workspace-server installation failed: Could not download x: 404',
    });
    expect(execScript).toHaveBeenCalledOnce();
  });

  it('decodes CLIXML installer errors into the failure message', async () => {
    const execScript = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce({
      stdout: '',
      stderr:
        '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Checksum mismatch_x000D__x000A_</S></Objs>',
      exitCode: 42,
    });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
      baseUrl: installBaseUrl,
    });

    await expect(
      installer.install({ connectionId: 'ssh-1', layout, version: '1.2.3' })
    ).rejects.toMatchObject({
      code: 'install-failed',
      message: 'Workspace-server installation failed: Checksum mismatch',
    });
  });

  it('resolves the Windows channel pointer with the stable fallback', async () => {
    const execScript = vi.fn().mockResolvedValue(ok(pointerBody('1.2.4-canary.1')));
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
      baseUrl: installBaseUrl,
      releaseChannel: 'canary',
    });

    await expect(installer.availableVersion('ssh-1', undefined, 'windows')).resolves.toBe(
      '1.2.4-canary.1'
    );
    const { script } = decodePowerShell(execScript.mock.calls[0]?.[0]);
    expect(script).toContain(
      `'${installBaseUrl}/channels/canary/protocol-${protocolMajor()}.json', ` +
        `'${installBaseUrl}/channels/stable/protocol-${protocolMajor()}.json'`
    );
  });

  it('reads the installed version from the current pointer', async () => {
    const execScript = vi.fn().mockResolvedValueOnce(ok('')).mockResolvedValueOnce(ok('1.2.3'));
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
    });

    await expect(installer.installedVersion('ssh-1', layout)).resolves.toBeUndefined();
    await expect(installer.installedVersion('ssh-1', layout)).resolves.toBe('1.2.3');
  });

  it('rejects an invalid current pointer', async () => {
    const execScript = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'The workspace-server current pointer is invalid: ../x',
      exitCode: 45,
    });
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn(async () => ({ execScript }) as never) },
    });

    await expect(installer.installedVersion('ssh-1', layout)).rejects.toMatchObject({
      code: 'install-failed',
      message: 'The workspace-server current pointer is invalid: ../x',
    });
  });

  it('builds the install scripts only for safe inputs', () => {
    expect(() =>
      buildWindowsWorkspaceServerInstallScripts(installBaseUrl, '1.2.3; calc', layout, 'abc')
    ).toThrow('Invalid workspace-server version');
    expect(() =>
      buildWindowsWorkspaceServerInstallScripts(installBaseUrl, '1.2.3', layout, '..\\x')
    ).toThrow('Invalid installer id');
    expect(() =>
      buildWindowsWorkspaceServerInstallScripts('ftp://x', '1.2.3', layout, 'abc')
    ).toThrow(expect.objectContaining({ code: 'artifact-download-failed' }));
  });
});

function pointerBody(artifactVersion: string, protocolVersion = PROTOCOL_VERSION): string {
  return `${JSON.stringify({ artifactVersion, protocolVersion })}\n`;
}
