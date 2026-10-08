import { sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import type { Scope } from '@emdash/shared/concurrency';
import { observe, peek } from '@emdash/wire/state';
import type { SshConnectionEvent } from '@core/primitives/ssh/api';
import type { SshConnectionControl } from '@core/primitives/ssh/api/node/connection-control';
import type { HostServerState } from '../../api';
import type { HostAvailabilityState } from '../../api/availability';
import type { HostService } from '../../api/node/host-service';
import type { MaestroWorkspaceServerTarget } from '../../api/targets';
import { createHostRuntimeAccess } from '../host-runtime-access';
import type { HostServiceEntry } from '../host-service';
import {
  ManagedHostConnection,
  type ManagedHostConnectionOptions,
} from '../managed-host-connection';
import type { HostStateModel } from '../state-model';
import {
  openMaestroWorkspaceServerTransport,
  type MaestroHostConnectPort,
} from '../workspace-server/connect/maestro-websocket-transport';
import type { WorkspaceServerConnection } from '../workspace-server/connect/wire-connection-manager';
import { MaestroHostWorkspaceServer } from './maestro-host-workspace-server';

export type CreateMaestroHostServiceOptions = {
  scope: Scope;
  host: HostRef;
  /** Connection intent is stored on the machine row, exactly as for SSH machines. */
  intent: Pick<SshConnectionControl, 'readIntent' | 'writeIntent'>;
  maestro: MaestroHostConnectPort;
  stateModel: HostStateModel;
  nextGeneration(): number;
  onReady(attachment: WorkspaceServerConnection): void;
  /**
   * The machine list reads connection state from the SSH connections model. A Maestro host has
   * no SSH connection, so its Host availability is projected into that model instead.
   */
  publishConnectionEvent?(event: SshConnectionEvent): void;
  client?: { id: string; appVersion: string };
  logger?: {
    debug?(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
  };
  /** Timing and retry overrides for tests. */
  supervision?: Pick<
    ManagedHostConnectionOptions,
    'clock' | 'random' | 'retrySchedule' | 'healthIntervalMs' | 'healthTimeoutMs'
  >;
};

type PublishedConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'error' | 'idle';

/**
 * Composes one Maestro host identity: the Maestro app on another computer, reached over its
 * WebSocket listener. It reuses the Host connection supervisor unchanged by giving it an SSH leg
 * that is always satisfied — there is no SSH connection to establish, probe, or reset — and a
 * runtime leg whose "provisioning" is only naming the machine to dial. Establishing is therefore
 * dial + initialize, health is the Wire health probe, and retry policy is the supervisor's.
 */
export function createMaestroHostService(
  options: CreateMaestroHostServiceOptions
): HostServiceEntry {
  const id = sshConnectionIdOf(options.host);
  if (!id) throw new Error('Local worker services are not managed Maestro hosts');
  const scope = options.scope.child(`host:${id}`);
  const target: MaestroWorkspaceServerTarget = { kind: 'maestro', connectionId: id };
  // Late work from a retired identity must not publish into the aggregate model by reused ID.
  const setServerState = (value: HostServerState) => {
    if (!scope.disposed) options.stateModel.set(id, value);
  };
  const publishHandshake = (attachment: WorkspaceServerConnection) => {
    const handshake = attachment.currentHandshake();
    if (!handshake) return;
    setServerState({
      status: 'healthy',
      version: handshake.server.appVersion,
      startedAt: handshake.server.startedAt,
    });
  };
  const managed = new ManagedHostConnection({
    ...options.supervision,
    scope,
    host: options.host,
    nextGeneration: options.nextGeneration,
    intent: {
      read: () => {
        scope.signal.throwIfAborted();
        return options.intent.readIntent(id);
      },
      write: (enabled) => {
        scope.signal.throwIfAborted();
        return options.intent.writeIntent(id, enabled);
      },
    },
    ssh: {
      connected: () => !scope.disposed,
      establish: async () => {
        scope.signal.throwIfAborted();
      },
      reset: () => {},
      probe: async () => {
        scope.signal.throwIfAborted();
      },
    },
    runtime: {
      prepare: async () => {
        scope.signal.throwIfAborted();
        return target;
      },
      open: (next, signal) => {
        if (next.kind !== 'maestro') throw new Error('Expected Maestro host target');
        return openMaestroWorkspaceServerTransport(next, options.maestro, { signal });
      },
      cancel: () => {},
    },
    client: options.client,
    log: (value, detail) =>
      options.logger?.debug?.('Host connection supervisor', { ...detail, ...value }),
    onReady: (attachment) => {
      if (scope.disposed) return;
      publishHandshake(attachment);
      options.onReady(attachment);
    },
  });

  let published: PublishedConnectionState | undefined;
  const project = (availability: HostAvailabilityState) => {
    const state = serverStateFor(availability, options.stateModel.get(id));
    if (state) setServerState(state);
    // A routine re-check of a connected Host is not a new connection attempt.
    const checking = availability.kind === 'preparing' && availability.phase === 'checking';
    const next =
      checking && published === 'connected' ? published : connectionStateFor(availability);
    if (next === published) return;
    // An idle Host that never connected has no state to retract.
    const first = published === undefined;
    published = next;
    if (first && next === 'idle') return;
    options.publishConnectionEvent?.(connectionEventFor(id, next, availability));
  };
  project(peek(managed.availability));
  observe(managed.availability, (current) => project(current.value), { scope });
  scope.add(() => {
    if (published && published !== 'idle')
      options.publishConnectionEvent?.({ type: 'disconnected', connectionId: id });
  });

  const service: HostService = {
    host: options.host,
    connection: managed,
    runtime: createHostRuntimeAccess(options.host, scope, managed),
    server: new MaestroHostWorkspaceServer({
      connectionId: id,
      scope,
      state: options.stateModel,
      refresh: () => {
        if (peek(managed.availability).kind === 'ready')
          publishHandshake(managed.supervisor.attachment);
      },
    }),
  };
  return {
    service,
    readyAttachment: () =>
      peek(managed.availability).kind === 'ready' ? managed.supervisor.attachment : undefined,
    connectSsh: () => managed.connectSsh(),
    ensureSsh: () => managed.supervisor.ensureSsh(),
    sshDisconnected: () => {},
    wake(cause) {
      if (cause === 'suspend') managed.supervisor.suspendSystem();
      else if (cause === 'resume') managed.supervisor.resume();
      else managed.supervisor.revalidate(cause);
    },
    dispose: () => scope.dispose(),
  };
}

/**
 * The server state a settled outage implies. Readiness is published from the handshake, and
 * in-flight work (checking, reconnecting, waiting to retry) keeps the last observed state.
 */
function serverStateFor(
  availability: HostAvailabilityState,
  current: HostServerState | undefined
): HostServerState | undefined {
  if (availability.kind === 'ready' || availability.kind === 'preparing') return undefined;
  if (availability.kind === 'unavailable') {
    if (availability.recovery === 'waiting') return undefined;
    if (availability.issue) {
      return {
        status: 'failed',
        version: current?.version,
        error: {
          code:
            availability.issue.type === 'host-unavailable'
              ? availability.issue.reason
              : availability.issue.type,
          message: availability.issue.message,
        },
      };
    }
  }
  return current ? { status: 'stopped', version: current.version } : undefined;
}

function connectionStateFor(availability: HostAvailabilityState): PublishedConnectionState {
  switch (availability.kind) {
    case 'ready':
      return 'connected';
    case 'preparing':
      return 'connecting';
    case 'suspended':
      return 'idle';
    case 'unavailable':
      if (availability.recovery === 'waiting') return 'reconnecting';
      return availability.issue ? 'error' : 'idle';
  }
}

function connectionEventFor(
  connectionId: string,
  state: PublishedConnectionState,
  availability: HostAvailabilityState
): SshConnectionEvent {
  switch (state) {
    case 'connected':
      return { type: 'connected', connectionId };
    case 'connecting':
      return { type: 'connecting', connectionId };
    case 'reconnecting':
      return { type: 'reconnecting', connectionId, attempt: 1, delayMs: 0 };
    case 'error':
      return {
        type: 'error',
        connectionId,
        errorMessage:
          availability.kind === 'unavailable' && availability.issue
            ? availability.issue.message
            : 'Host connection failed',
      };
    case 'idle':
      return { type: 'disconnected', connectionId };
  }
}
