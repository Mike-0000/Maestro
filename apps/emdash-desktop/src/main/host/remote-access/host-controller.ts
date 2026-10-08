import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { remoteDeviceWireContract } from '@emdash/core/services/remote-control/api';
import { hostRuntimesDefinitions } from '@emdash/core/services/runtime-broker/api';
import {
  negotiateProtocol,
  portForwardsContract,
  PROTOCOL_VERSION,
  workspaceWireContract,
} from '@emdash/core/workspace-server';
import { err, ok } from '@emdash/shared';
import {
  createController,
  defineContract,
  forwardContractImpl,
  type Controller,
} from '@emdash/wire/rpc';
import type { DesktopRuntimeClients } from '@main/gateway/desktop-workers';
import type { RemoteControlImpl } from './remote-control';

/**
 * What a paired Maestro app is served: the workspace-server contract, answered by this app's
 * own workers instead of a daemon, plus remote control. Paths match `workspaceWireContract`
 * exactly, so a client reaches this computer with the code it uses for any other host.
 */
export const maestroHostWireContract = defineContract({
  health: workspaceWireContract.health,
  initialize: workspaceWireContract.initialize,
  ...hostRuntimesDefinitions,
  portForwards: portForwardsContract,
  remote: remoteDeviceWireContract.remote,
});

const PORT_PROBE_TIMEOUT_MS = 500;

export function createMaestroHostController(options: {
  clients: DesktopRuntimeClients;
  remote: RemoteControlImpl;
  appVersion: string;
}): Controller {
  const { clients } = options;
  const startedAt = Date.now();
  const daemonId = randomUUID();

  return createController(maestroHostWireContract, {
    health: () => ({
      status: 'ok' as const,
      version: options.appVersion,
      uptimeMs: Date.now() - startedAt,
      protocolVersion: PROTOCOL_VERSION,
    }),
    initialize: ({ protocolVersion }) => {
      const result = negotiateProtocol(protocolVersion, PROTOCOL_VERSION);
      if (!result.compatible) {
        return err({
          type: 'protocol-incompatible' as const,
          action: result.action,
          clientProtocolVersion: result.clientProtocolVersion,
          serverProtocolVersion: result.serverProtocolVersion,
        });
      }
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        agreedVersion: result.agreedVersion,
        agreedMinor: result.agreedMinor,
        server: { appVersion: options.appVersion, daemonId, startedAt },
      });
    },
    acp: {
      ...forwardContractImpl(maestroHostWireContract.acp, clients.acp),
      // A turn runs for as long as the agent works; the worker client's call timeout must not
      // cut it short.
      sendPrompt: (input, meta) =>
        clients.acp.sendPrompt(input, { signal: meta.signal, timeoutMs: 0 }),
    },
    agentConfig: forwardContractImpl(maestroHostWireContract.agentConfig, clients.agentConfig),
    automations: forwardContractImpl(maestroHostWireContract.automations, clients.automations),
    conversations: forwardContractImpl(
      maestroHostWireContract.conversations,
      clients.conversations
    ),
    fileSearch: forwardContractImpl(maestroHostWireContract.fileSearch, clients.fileSearch),
    files: forwardContractImpl(maestroHostWireContract.files, clients.files),
    git: forwardContractImpl(maestroHostWireContract.git, clients.git),
    hostDependencies: forwardContractImpl(
      maestroHostWireContract.hostDependencies,
      clients.hostDependencies
    ),
    hostSettings: forwardContractImpl(maestroHostWireContract.hostSettings, clients.hostSettings),
    resourceUsage: forwardContractImpl(
      maestroHostWireContract.resourceUsage,
      clients.resourceUsage
    ),
    scripts: forwardContractImpl(maestroHostWireContract.scripts, clients.scripts),
    terminals: forwardContractImpl(maestroHostWireContract.terminals, clients.terminals),
    tuiAgents: forwardContractImpl(maestroHostWireContract.tuiAgents, clients.tuiAgents),
    workspaceRegistry: forwardContractImpl(
      maestroHostWireContract.workspaceRegistry,
      clients.workspaceRegistry
    ),
    portForwards: {
      inspect: async ({ port }) => {
        const [ipv4, ipv6] = await Promise.all([
          probeLoopbackPort('127.0.0.1', port),
          probeLoopbackPort('::1', port),
        ]);
        const families = [
          ...(ipv4 ? (['ipv4'] as const) : []),
          ...(ipv6 ? (['ipv6'] as const) : []),
        ];
        return ok({ listening: families.length > 0, families });
      },
    },
    remote: options.remote,
  });
}

/** What a paired browser is served: remote control and nothing else. */
export function createBrowserDeviceController(remote: RemoteControlImpl): Controller {
  return createController(remoteDeviceWireContract, { remote });
}

function probeLoopbackPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => finish(false), PORT_PROBE_TIMEOUT_MS);
    const finish = (listening: boolean): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
