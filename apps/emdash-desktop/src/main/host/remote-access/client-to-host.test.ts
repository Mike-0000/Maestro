import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  remoteDeviceWireContract,
  type RemoteOverview,
} from '@emdash/core/services/remote-control/api';
import { hostRuntimesDefinitions } from '@emdash/core/services/runtime-broker/api';
import { PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { ok, type Secret } from '@emdash/shared';
import {
  client,
  connect,
  memoryTransportPair,
  serve,
  type Contract,
  type ContractDefinitions,
} from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaestroHostClient } from '@core/features/machines/node/maestro-host-client';
import { normalizeMaestroHostUrl } from '@core/primitives/maestro-host/api/endpoint';
import {
  MaestroHostConnectionError,
  openMaestroWorkspaceServerTransport,
} from '@core/services/hosts/node/workspace-server/connect/maestro-websocket-transport';
import { initializeWorkspaceServerTransport } from '@core/services/hosts/node/workspace-server/connect/protocol';
import type { DesktopRuntimeClients } from '@main/gateway/desktop-workers';
import { RemoteDeviceStore } from './device-store';
import { createMaestroHostController } from './host-controller';
import { createRemoteAccessHttpServer, type RemoteAccessHttpServer } from './http-server';
import { PairingCodes } from './pairing';

/**
 * The two halves were written against a shared description of the HTTP and WebSocket
 * surface. This runs the client's real pairing and dial code against the host's real
 * listener, so a drift between them fails here rather than between two computers.
 */
describe('a Maestro client against a Maestro host', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cleanups: Array<() => void> = [];
  let directory: string;
  let store: RemoteDeviceStore;
  let pairing: PairingCodes;
  let http: RemoteAccessHttpServer;
  let base: string;

  function idleClient<Defs extends ContractDefinitions>(contract: Contract<Defs>) {
    const pair = memoryTransportPair();
    const connection = connect(pair.left);
    cleanups.push(() => {
      connection.dispose();
      pair.disconnect();
    });
    return client(contract, connection);
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-client-host-'));
    store = new RemoteDeviceStore(join(directory, 'remote-access.json'));
    const settings = await store.load();
    pairing = new PairingCodes();
    const clients = Object.fromEntries(
      Object.entries(hostRuntimesDefinitions).map(([name, contract]) => [
        name,
        idleClient(contract as Contract<ContractDefinitions>),
      ])
    ) as unknown as DesktopRuntimeClients;
    const controller = createMaestroHostController({
      clients,
      appVersion: '9.9.9',
      remote: {
        overview: expose(remoteDeviceWireContract.remote.overview, {
          snapshot: cell<RemoteOverview>({
            host: { id: 'h', name: 'studio', appVersion: '9.9.9' },
            projects: [],
            agents: [],
            providers: [],
            defaultProviderId: null,
          }),
        }),
        output: () => {
          throw new Error('No terminal in this test');
        },
        adoptConversation: async ({ conversationId }) =>
          ok({ taskId: `task-for-${conversationId}`, projectId: 'p1' }),
      },
    });
    http = createRemoteAccessHttpServer({
      store,
      pairing,
      staticRoot: join(directory, 'web'),
      hostInfo: () => ({
        hostId: settings.hostId,
        hostName: 'studio',
        protocolVersion: PROTOCOL_VERSION,
      }),
      openSession: (_device, transport) => {
        serve(transport, controller);
      },
      onDevicesChanged: () => {},
      logger: logger as never,
    });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    const normalized = normalizeMaestroHostUrl(
      `127.0.0.1:${(http.server.address() as AddressInfo).port}`
    );
    if (!normalized.success) throw new Error(normalized.error.message);
    base = normalized.data;
  });

  afterEach(async () => {
    await http.close();
    for (const cleanup of cleanups.splice(0)) cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  async function pairClient(): Promise<Secret<string>> {
    const paired = await createMaestroHostClient().pair(base, {
      code: pairing.issue().code,
      deviceName: 'Laptop',
    });
    if (!paired.success) throw new Error(paired.error.message);
    return paired.data.token;
  }

  it('identifies the host, pairs, connects, and completes the handshake', async () => {
    const hostClient = createMaestroHostClient();
    expect(await hostClient.info(base)).toEqual({
      success: true,
      data: {
        hostId: store.current().hostId,
        hostName: 'studio',
        protocolVersion: PROTOCOL_VERSION,
      },
    });

    const token = await pairClient();
    expect(store.devices()).toMatchObject([{ name: 'Laptop', kind: 'desktop' }]);

    const handshake = await initializeWorkspaceServerTransport(
      await openMaestroWorkspaceServerTransport(
        { kind: 'maestro', connectionId: 'm1' },
        { resolve: async () => ({ url: base, token }) }
      )
    );
    expect(handshake.server.appVersion).toBe('9.9.9');

    const transport = await openMaestroWorkspaceServerTransport(
      { kind: 'maestro', connectionId: 'm1' },
      { resolve: async () => ({ url: base, token }) }
    );
    const api = client(remoteDeviceWireContract, connect(transport));
    expect(
      await api.remote.adoptConversation({
        conversationId: 'c1',
        taskName: 'Fix the build',
        workspacePath: '/code/app',
      })
    ).toEqual({ success: true, data: { taskId: 'task-for-c1', projectId: 'p1' } });
    transport.close?.();
  });

  it('tells the client its code was wrong', async () => {
    pairing.issue();
    const result = await createMaestroHostClient().pair(base, {
      code: 'AAAA-AAAA',
      deviceName: 'Laptop',
    });
    expect(result).toMatchObject({ success: false, error: { type: 'invalid-code' } });
  });

  it('reports a revoked device as no longer paired', async () => {
    const token = await pairClient();
    await store.removeDevice(store.devices()[0]!.id);

    const error = await openMaestroWorkspaceServerTransport(
      { kind: 'maestro', connectionId: 'm1' },
      { resolve: async () => ({ url: base, token }) }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MaestroHostConnectionError);
    expect((error as MaestroHostConnectionError).code).toBe('not-paired');
  });
});
