import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Controller, WireTransport } from '@emdash/wire/rpc';
import { createWireSessionHub, streamTransport } from '@emdash/wire/rpc';
import {
  createWorkspaceServerPipeAddress,
  defaultDaemonEndpointMode,
  readEndpointRecord,
  removeEndpointRecord,
  writeEndpointRecord,
  type DaemonEndpointMode,
} from '../daemon/endpoint';
import { DEFAULT_WORKSPACE_SERVER_SOCKET_PATH } from '../daemon/paths';

export type SocketServeOptions = {
  socketPath?: string;
  endpointMode?: DaemonEndpointMode;
};

export type SocketServeHandle = {
  /** The well-known path: the socket itself, or the endpoint record in `record` mode. */
  socketPath: string;
  /** The address the server listens on (equal to `socketPath` in `socket` mode). */
  listenAddress: string;
  dispose(): Promise<void>;
};

export async function serveSocket(
  controller: Controller,
  options: SocketServeOptions = {}
): Promise<SocketServeHandle> {
  const socketPath = options.socketPath ?? DEFAULT_WORKSPACE_SERVER_SOCKET_PATH;
  const endpointMode = options.endpointMode ?? defaultDaemonEndpointMode();
  const server = createServer();
  const hub = createWireSessionHub(controller);

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  let listenAddress: string;
  if (endpointMode === 'record') {
    await assertRecordedEndpointIdle(socketPath);
    listenAddress = createWorkspaceServerPipeAddress();
  } else {
    await unlinkStaleSocket(socketPath);
    listenAddress = socketPath;
  }

  server.on('connection', (socket) => {
    socket.on('error', () => {
      // The wire transport observes close/end; individual socket errors do not
      // need to crash the daemon.
    });
    hub.open(randomUUID(), socketTransport(socket));
  });

  await listen(server, listenAddress);
  if (endpointMode === 'record') {
    try {
      await writeEndpointRecord(socketPath, listenAddress);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  }

  return {
    socketPath,
    listenAddress,
    async dispose() {
      await hub.dispose();
      await closeServer(server);
      if (endpointMode === 'record') {
        await removeEndpointRecord(socketPath, listenAddress).catch(() => {});
      } else {
        await unlink(socketPath).catch(() => {});
      }
    },
  };
}

async function assertRecordedEndpointIdle(recordPath: string): Promise<void> {
  const record = await readEndpointRecord(recordPath);
  if (record.kind !== 'found') return;
  if (await canConnect(record.address)) {
    throw new Error(`Workspace server is already listening at ${record.address} (${recordPath})`);
  }
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const live = await canConnect(socketPath);
  if (live) {
    throw new Error(`Workspace server socket is already in use: ${socketPath}`);
  }
  await unlink(socketPath);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function socketTransport(socket: Socket): WireTransport {
  const transport = streamTransport(socket, socket);
  return {
    ...transport,
    close() {
      transport.close?.();
      socket.destroy();
    },
  };
}
