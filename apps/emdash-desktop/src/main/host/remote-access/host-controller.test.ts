import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { remoteDeviceWireContract } from '@emdash/core/services/remote-control/api';
import { hostRuntimesDefinitions } from '@emdash/core/services/runtime-broker/api';
import { PROTOCOL_VERSION, workspaceWireContract } from '@emdash/core/workspace-server';
import { ok } from '@emdash/shared';
import { acceptWebSocket, connectWebSocket } from '@emdash/wire/node';
import {
  client,
  connect,
  memoryTransportPair,
  serve,
  type Contract,
  type ContractDefinitions,
  type WireTransport,
} from '@emdash/wire/rpc';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeWorkspaceServerTransport } from '@core/services/hosts/node/workspace-server/connect/protocol';
import type { DesktopRuntimeClients } from '@main/gateway/desktop-workers';
import { createBrowserDeviceController, createMaestroHostController } from './host-controller';
import { testRemoteControl } from './testing';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A worker client with nothing behind it: enough to mount, never answered. */
function idleClient<Defs extends ContractDefinitions>(contract: Contract<Defs>) {
  const pair = memoryTransportPair();
  const connection = connect(pair.left);
  cleanups.push(() => {
    connection.dispose();
    pair.disconnect();
  });
  return client(contract, connection);
}

function runtimeClients(): DesktopRuntimeClients {
  const entries = Object.entries(hostRuntimesDefinitions).map(([name, contract]) => [
    name,
    idleClient(contract as Contract<ContractDefinitions>),
  ]);
  const clients = Object.fromEntries(entries) as Record<string, unknown>;
  return clients as unknown as DesktopRuntimeClients;
}

const remote = testRemoteControl({
  startAgent: async ({ projectId }) => ok({ taskId: `task-${projectId}`, conversationId: 'c1' }),
});

async function listen(controller: ReturnType<typeof createMaestroHostController>): Promise<string> {
  const server: Server = createServer();
  // Upgraded sockets are not closed by the server, so they are closed by hand.
  const accepted: WireTransport[] = [];
  server.on('upgrade', (request, socket, head) => {
    const transport = acceptWebSocket(request, socket, head);
    accepted.push(transport);
    serve(transport, controller);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const transport of accepted) transport.close?.();
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/wire`;
}

describe('Maestro host controller', () => {
  it('completes the workspace-server handshake a desktop client performs', async () => {
    const url = await listen(
      createMaestroHostController({ clients: runtimeClients(), remote, appVersion: '1.2.3' })
    );

    const handshake = await initializeWorkspaceServerTransport(await connectWebSocket({ url }));
    expect(handshake.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(handshake.server.appVersion).toBe('1.2.3');

    const transport = await connectWebSocket({ url });
    cleanups.push(() => transport.close?.());
    const api = client(workspaceWireContract, connect(transport));
    expect(await api.health()).toMatchObject({ status: 'ok', version: '1.2.3' });
  });

  it('refuses a client from an incompatible protocol major', async () => {
    const url = await listen(
      createMaestroHostController({ clients: runtimeClients(), remote, appVersion: '1.2.3' })
    );
    await expect(
      initializeWorkspaceServerTransport(await connectWebSocket({ url }), '1.0.0')
    ).rejects.toThrow();
  });

  it('serves remote control to a desktop on the same paths a browser uses', async () => {
    const url = await listen(
      createMaestroHostController({ clients: runtimeClients(), remote, appVersion: '1.2.3' })
    );
    const transport = await connectWebSocket({ url });
    cleanups.push(() => transport.close?.());
    const api = client(remoteDeviceWireContract, connect(transport));
    expect(await api.remote.startAgent({ projectId: 'p1', prompt: 'hi' })).toEqual({
      success: true,
      data: { taskId: 'task-p1', conversationId: 'c1' },
    });
  });

  it('gives a browser remote control and no workspace runtime', async () => {
    const url = await listen(createBrowserDeviceController(remote));
    const transport = await connectWebSocket({ url });
    cleanups.push(() => transport.close?.());
    const connection = connect(transport);

    const remoteApi = client(remoteDeviceWireContract, connection);
    expect((await remoteApi.remote.startAgent({ projectId: 'p2', prompt: '' })).success).toBe(true);

    const hostApi = client(workspaceWireContract, connection);
    await expect(hostApi.health()).rejects.toMatchObject({ code: 'UNKNOWN_PROCEDURE' });
    await expect(hostApi.portForwards.inspect({ port: 4000 })).rejects.toMatchObject({
      code: 'UNKNOWN_PROCEDURE',
    });
  });
});
