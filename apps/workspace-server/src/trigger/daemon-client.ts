import { createConnection, type Socket } from 'node:net';
import type { TriggerDaemon, TriggerDaemonError } from '@emdash/core/runtimes/automations/node';
import {
  PROTOCOL_VERSION,
  protocolUpgradeMessage,
  workspaceWireContract,
} from '@emdash/core/workspace-server';
import { err, ok, type Result } from '@emdash/shared';
import { client as createClient, connect, streamTransport } from '@emdash/wire/rpc';
import { resolveDaemonConnectAddress } from '../daemon/endpoint';

const CONNECT_TIMEOUT_MS = 3_000;
const CALL_TIMEOUT_MS = 15_000;

type WorkspaceClient = ReturnType<typeof createClient<typeof workspaceWireContract>>;

/**
 * Opens one connection per call. Requests are rare and the socket is local, so this
 * costs nothing and means a daemon restart never leaves the gateway holding a dead
 * connection that needs its own recovery logic.
 */
export function createTriggerDaemon(options: {
  socketPath: string;
  appVersion: string;
}): TriggerDaemon {
  async function withClient<T>(
    call: (client: WorkspaceClient, signal: AbortSignal) => Promise<Result<T, TriggerDaemonError>>
  ): Promise<Result<T, TriggerDaemonError>> {
    let socket: Socket | undefined;
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      const address = await resolveDaemonConnectAddress(options.socketPath);
      if (address.kind === 'unavailable') {
        return err({ type: 'daemon-unavailable', message: address.message });
      }
      socket = await connectToSocket(address.address);
      const transport = streamTransport(socket, socket);
      const client = createClient(workspaceWireContract, connect(transport));
      try {
        const hello = await client.initialize(
          {
            protocolVersion: PROTOCOL_VERSION,
            client: { id: 'trigger-gateway', appVersion: options.appVersion },
          },
          { signal: timeout }
        );
        if (!hello.success) {
          return err({
            type: hello.error.type,
            message: protocolUpgradeMessage(hello.error.action),
          });
        }
        return await call(client, timeout);
      } finally {
        transport.close?.();
      }
    } catch (error) {
      return err({
        type: 'daemon-unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      socket?.destroy();
    }
  }

  return {
    async healthy() {
      const result = await withClient(async () => ok(true));
      return result.success;
    },
    startRun: (automationId, request) =>
      withClient(async (client, signal) => {
        const result = await client.automations.startRun({ automationId, request }, { signal });
        return result.success ? ok(result.data.run) : err(result.error);
      }),
    getRun: (automationId, runId) =>
      withClient(async (client, signal) => {
        const result = await client.automations.getRun({ automationId, runId }, { signal });
        return result.success ? ok(result.data.run) : err(result.error);
      }),
    cancelRun: (automationId, runId) =>
      withClient(async (client, signal) => {
        const result = await client.automations.cancelRun({ automationId, runId }, { signal });
        return result.success ? ok(undefined) : err(result.error);
      }),
    queuedCount: (automationId) =>
      withClient(async (client, signal) => {
        const result = await client.automations.getRunOverview({ automationId }, { signal });
        return result.success ? ok(result.data.counts['queued'] ?? 0) : err(result.error);
      }),
  };
}

function connectToSocket(address: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to the workspace server at ${address}`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', reject);
      // The wire transport observes close; later socket errors must not crash the gateway.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
