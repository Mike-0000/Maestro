import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { windowsWorkspaceServerLayout, workspaceServerLayout } from '../layout';
import { RemoteWorkspaceServerDaemon, WorkspaceServerDaemonError } from './daemon-control';

function setup(result = { stdout: '', stderr: '', exitCode: 0 }) {
  const exec = vi.fn<SshClientProxy['exec']>().mockResolvedValue(result);
  const execScript = vi.fn<SshClientProxy['execScript']>().mockResolvedValue(result);
  const proxy = { exec, execScript } as Pick<SshClientProxy, 'exec' | 'execScript'>;
  const ensureProxy = vi.fn(async () => proxy as SshClientProxy);
  const logger = { warn: vi.fn() };
  return {
    exec,
    execScript,
    logger,
    daemon: new RemoteWorkspaceServerDaemon({ ensureProxy }, logger),
  };
}

function decodePowerShell(command: string): string {
  return Buffer.from(command.split(' ').at(-1) ?? '', 'base64').toString('utf16le');
}

describe('RemoteWorkspaceServerDaemon', () => {
  it('runs the POSIX launcher with structured arguments', async () => {
    const { daemon, exec, execScript } = setup();
    const layout = workspaceServerLayout('/home/dev');

    await daemon.start('ssh-1', layout);

    expect(exec).toHaveBeenCalledWith(
      { command: layout.currentLauncher, args: ['start', '--socket', layout.socketPath] },
      expect.objectContaining({ timeoutMs: 30_000 })
    );
    expect(execScript).not.toHaveBeenCalled();
  });

  it('runs the Windows control script through encoded PowerShell', async () => {
    const { daemon, exec, execScript } = setup();
    const layout = windowsWorkspaceServerLayout('C:\\Users\\dev');

    await daemon.stop('ssh-1', layout);

    expect(exec).not.toHaveBeenCalled();
    const [command, options] = execScript.mock.calls[0] ?? [];
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = decodePowerShell(command ?? '');
    expect(script).toContain(`$pointer = '${layout.currentPointer}'`);
    expect(script).toContain(`& $node $entrypoint 'stop' '--socket' '${layout.socketPath}'`);
    expect(options).toMatchObject({ timeoutMs: 60_000 });
  });

  it('reports decoded Windows failures', async () => {
    const { daemon } = setup({
      stdout: '',
      stderr:
        '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">The workspace server is not ' +
        'installed._x000D__x000A_</S></Objs>',
      exitCode: 44,
    });

    await expect(
      daemon.start('ssh-1', windowsWorkspaceServerLayout('C:\\Users\\dev'))
    ).rejects.toThrow(
      new WorkspaceServerDaemonError(
        'Workspace-server start failed: The workspace server is not installed.'
      )
    );
  });

  it('falls back to the exit code when a failure prints nothing', async () => {
    const { daemon } = setup({ stdout: '', stderr: '', exitCode: 3 });

    await expect(daemon.status('ssh-1', workspaceServerLayout('/home/dev'))).rejects.toThrow(
      'Workspace-server status failed: exit 3'
    );
  });

  it('logs warnings from a successful start', async () => {
    const { daemon, logger } = setup({
      stdout: '',
      stderr: 'The daemon could not leave the SSH session.\n',
      exitCode: 0,
    });

    await daemon.start('ssh-1', windowsWorkspaceServerLayout('C:\\Users\\dev'));

    expect(logger.warn).toHaveBeenCalledWith('Workspace-server start reported warnings', {
      connectionId: 'ssh-1',
      warnings: 'The daemon could not leave the SSH session.',
    });
  });

  it('restarts even when stop fails', async () => {
    const { daemon, exec } = setup();
    exec.mockResolvedValueOnce({ stdout: '', stderr: 'not running', exitCode: 1 });

    await daemon.restart('ssh-1', workspaceServerLayout('/home/dev'));

    expect(exec.mock.calls.map(([command]) => command.args?.[0])).toEqual(['stop', 'start']);
  });
});
