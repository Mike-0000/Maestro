import {
  decodePowerShellStderr,
  formatPowerShellEncodedCommand,
} from '@emdash/core/primitives/exec/api';
import type { ClientChannel } from 'ssh2';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { buildWindowsPipeBridgeScript, WINDOWS_PIPE_BRIDGE_READY_MARKER } from '../windows-scripts';

export class WindowsPipeBridgeError extends Error {
  readonly name = 'WindowsPipeBridgeError';
}

const MAX_STDERR_CHARS = 16 * 1_024;
// Covers a cold powershell.exe start plus the bridge's own 5s pipe connect timeout.
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Opens an exec channel running the named-pipe bridge and resolves once the bridge reports that
 * it connected to the daemon, so failures surface as the bridge's own diagnostic instead of a
 * silently closed stream. The caller owns the returned channel.
 */
export async function openWindowsPipeBridge(
  proxy: Pick<SshClientProxy, 'openExecChannel'>,
  recordPath: string,
  options: { signal?: AbortSignal; readyTimeoutMs?: number } = {}
): Promise<ClientChannel> {
  const command = formatPowerShellEncodedCommand(buildWindowsPipeBridgeScript(recordPath));
  const channel = await proxy.openExecChannel(command, { signal: options.signal });
  try {
    await waitUntilReady(
      channel,
      options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      options.signal
    );
  } catch (error) {
    channel.destroy();
    throw error;
  }
  return channel;
}

function waitUntilReady(
  channel: ClientChannel,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let exitCode: number | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      channel.stderr.off('data', onStderr);
      channel.off('exit', onExit);
      channel.off('close', onClose);
      channel.off('error', onError);
      // Keep draining stderr so a chatty remote cannot stall the channel's flow control.
      channel.stderr.resume();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onStderr = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      // Keep only the tail: the marker and any failure message arrive last.
      stderr = (stderr + text).slice(-MAX_STDERR_CHARS);
      if (stderr.includes(WINDOWS_PIPE_BRIDGE_READY_MARKER)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      exitCode = code ?? undefined;
    };
    const onClose = () => {
      const detail = decodePowerShellStderr(stderr).trim();
      fail(
        new WindowsPipeBridgeError(
          detail ||
            `The workspace-server bridge exited before connecting (exit ${exitCode ?? 'unknown'})`
        )
      );
    };
    const onError = (error: Error) => fail(error);
    const onAbort = () => {
      const reason: unknown = signal?.reason;
      fail(reason instanceof Error ? reason : new Error('Workspace-server bridge open aborted'));
    };
    const timer = setTimeout(
      () =>
        fail(
          new WindowsPipeBridgeError(
            `The workspace-server bridge did not connect within ${timeoutMs}ms`
          )
        ),
      timeoutMs
    );
    timer.unref?.();

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    channel.stderr.on('data', onStderr);
    channel.once('exit', onExit);
    channel.once('close', onClose);
    channel.once('error', onError);
  });
}
