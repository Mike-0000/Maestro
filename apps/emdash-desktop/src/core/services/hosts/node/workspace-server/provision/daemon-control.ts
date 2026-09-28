import { execPowerShell } from '@core/primitives/ssh/api/node/remote-platform-probe';
import type { SshExecResult } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import type { WorkspaceServerLayout } from '../layout';
import type { WorkspaceServerSshPort } from '../ports';
import { buildWindowsDaemonControlScript } from '../windows-scripts';

export class WorkspaceServerDaemonError extends Error {
  readonly name = 'WorkspaceServerDaemonError';
}

type DaemonLogger = { warn(message: string, metadata?: Record<string, unknown>): void };

const controlOptions = {
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1_024,
  maxStderrBytes: 64 * 1_024,
} as const;

export class RemoteWorkspaceServerDaemon {
  constructor(
    private readonly ssh: WorkspaceServerSshPort,
    private readonly logger?: DaemonLogger
  ) {}

  start(connectionId: string, layout: WorkspaceServerLayout, signal?: AbortSignal): Promise<void> {
    return this.run(connectionId, layout, 'start', signal);
  }

  stop(connectionId: string, layout: WorkspaceServerLayout, signal?: AbortSignal): Promise<void> {
    return this.run(connectionId, layout, 'stop', signal);
  }

  status(connectionId: string, layout: WorkspaceServerLayout, signal?: AbortSignal): Promise<void> {
    return this.run(connectionId, layout, 'status', signal);
  }

  async restart(
    connectionId: string,
    layout: WorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<void> {
    await this.stop(connectionId, layout, signal).catch(() => {});
    await this.start(connectionId, layout, signal);
  }

  private async run(
    connectionId: string,
    layout: WorkspaceServerLayout,
    action: 'start' | 'stop' | 'status',
    signal?: AbortSignal
  ): Promise<void> {
    const proxy = await this.ssh.ensureProxy(connectionId);
    const result: SshExecResult =
      layout.platform === 'windows'
        ? await execPowerShell(proxy, buildWindowsDaemonControlScript(layout, action), {
            ...controlOptions,
            // Windows starts add a WMI hop and a cold node.exe start the daemon waits up to 15s for.
            timeoutMs: 60_000,
            signal,
          })
        : await proxy.exec(
            { command: layout.currentLauncher, args: [action, '--socket', layout.socketPath] },
            { ...controlOptions, signal }
          );
    if (result.exitCode !== 0) {
      throw new WorkspaceServerDaemonError(
        `Workspace-server ${action} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      );
    }
    // A successful start can still report problems, such as a daemon that could not leave the
    // Windows SSH session and may stop with it.
    const warnings = result.stderr.trim();
    if (warnings) {
      this.logger?.warn(`Workspace-server ${action} reported warnings`, {
        connectionId,
        warnings,
      });
    }
  }
}
