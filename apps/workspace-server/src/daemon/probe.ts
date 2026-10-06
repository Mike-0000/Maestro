import { createConnection, type Socket } from 'node:net';
import { workspaceWireContract } from '@emdash/core/workspace-server';
import { err, ok, type Result } from '@emdash/shared';
import { runWithTimeout } from '@emdash/shared/scheduling';
import { client as createClient, connect, streamTransport } from '@emdash/wire/rpc';
import { resolveDaemonConnectAddress, type DaemonEndpointMode } from './endpoint';

export type DaemonHealth = Awaited<
  ReturnType<ReturnType<typeof createClient<typeof workspaceWireContract>>['health']>
>;

export type DaemonProbeError = {
  type: 'not-running' | 'unhealthy';
  message: string;
};

export async function probeDaemon(
  socketPath: string,
  options: { timeoutMs?: number; endpointMode?: DaemonEndpointMode } = {}
): Promise<Result<DaemonHealth, DaemonProbeError>> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  let socket: Socket | undefined;
  try {
    const address = await resolveDaemonConnectAddress(socketPath, options.endpointMode);
    if (address.kind === 'unavailable') {
      return err({ type: 'not-running', message: address.message });
    }
    socket = await connectToSocket(address.address, timeoutMs);
    const transport = streamTransport(socket, socket);
    const wireClient = createClient(workspaceWireContract, connect(transport));
    const health = await runWithTimeout((signal) => wireClient.health(undefined, { signal }), {
      timeoutMs,
    });
    transport.close?.();
    socket.destroy();
    return ok(health);
  } catch (error) {
    socket?.destroy();
    const message = error instanceof Error ? error.message : String(error);
    return err({
      type: isConnectionError(error) ? 'not-running' : 'unhealthy',
      message: isAccessDeniedError(error) ? `${ACCESS_DENIED_HINT} (${message})` : message,
    });
  }
}

/**
 * A Windows daemon that was started elevated listens on a pipe only Administrators may open, so a
 * non-elevated client of the same user is refused. It is running, and must not be started again.
 */
const ACCESS_DENIED_HINT =
  'The workspace server is already running with administrator rights, so this app is not ' +
  'allowed to connect to it. Stop it from an administrator terminal or restart the computer, ' +
  'then connect again';

function isAccessDeniedError(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    error instanceof Error &&
    'code' in error &&
    ['EPERM', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))
  );
}

function connectToSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Timed out connecting to workspace daemon socket: ${socketPath}`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function isConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(
      String((error as NodeJS.ErrnoException).code)
    )
  );
}
