import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { createEventStreamHost, type EventStreamHost } from '@emdash/wire/live';
import { createController, serve, WireError, type Controller } from '@emdash/wire/rpc';
import type { WireTransport } from '@emdash/wire/rpc';
import { buildsCompatible, describeBuild } from '@core/features/client-mode/api/build-identity';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import type {
  HostUpdateError,
  HostUpdateRequest,
  HostUpdateState,
} from '@core/features/client-mode/api/host-update';
import {
  ownerSessionContract,
  type OwnerAttachData,
  type OwnerAttachError,
  type OwnerAttachInput,
  type OwnerHostInfo,
} from '@core/features/client-mode/api/owner-contract';
import type { OwnerRequestContext } from './owner-auth';
import { OWNER_DESKTOP_PREFIX, refusedLiveLease, refusedLiveSource } from './owner-desktop-filter';

// One owner link per WebSocket connection. Each connection gets its own controller: `session.*`
// is the handshake, and nothing under `bridge.*` or `desktop.*` answers until `session.attach`
// succeeded on that very connection. At most one connection is attached at a time across all
// owner devices. The host-update verbs answer before `attach` too: a client blocked on a build
// mismatch cannot attach, and asking the host to update is how it gets unblocked. The caller is
// already an authenticated owner device.

const SESSION_PREFIX = 'session.';
const BRIDGE_PREFIX = 'bridge.';
/** Session endpoints usable before `attach`. */
const OPEN_SESSION_PATHS = new Set([
  'attach',
  'ping',
  'events',
  'hostUpdateState',
  'requestHostUpdate',
]);
/** How long a superseded connection stays open so its `superseded` event reaches the client. */
const SUPERSEDE_CLOSE_DELAY_MS = 250;

export type OwnerClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemOwnerClock: OwnerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The owner client attached right now. */
export type AttachedOwner = {
  sessionId: string;
  deviceId: string;
  clientName: string;
  clientPlatform: string;
  since: number;
  context: OwnerRequestContext;
};

/** Who opened a connection, as the upgrade authenticated it. */
export type OwnerConnectionIdentity = {
  deviceId: string;
  deviceName: string;
  context: OwnerRequestContext;
};

export type OwnerSessionDependencies = {
  /** Owner access is on; checked again at attach. */
  enabled(): boolean;
  hostBuild(): Promise<BuildIdentity>;
  /** Development hosts may skip the build check (`MAESTRO_SKIP_BUILD_CHECK=1`, unpackaged). */
  skipBuildCheck: boolean;
  /** Changes every time the host process starts. */
  hostBootId: string;
  hostInfo(): OwnerHostInfo;
  brainEpoch(): number;
  /** The `bridge.*` mount (paths without the prefix). */
  bridge: Controller;
  /** The `desktop.*` mount (full `desktop.` paths); see `createOwnerDesktopFilter`. */
  desktop: Controller;
  /** The host's own updater (the unattended update policy); `unsupported` without it. */
  hostUpdates?: {
    state(): HostUpdateState;
    request(request: HostUpdateRequest): Promise<Result<void, HostUpdateError>>;
  };
  /** The attached owner changed (attach, takeover, or detach). */
  onActiveChanged(active: AttachedOwner | null, previous: AttachedOwner | null): void;
  logger: Logger;
  clock?: OwnerClock;
};

type OwnerConnection = {
  readonly id: string;
  readonly identity: OwnerConnectionIdentity;
  readonly transport: WireTransport;
  readonly events: EventStreamHost<typeof ownerSessionContract.events>;
  /** `data` is null only while `attach` is still assembling it. */
  attached: { owner: AttachedOwner; data: OwnerAttachData | null } | undefined;
  closed: boolean;
  closeTimer: unknown;
};

export class OwnerSessions {
  private readonly connections = new Set<OwnerConnection>();
  private active: OwnerConnection | undefined;
  private readonly clock: OwnerClock;

  constructor(private readonly deps: OwnerSessionDependencies) {
    this.clock = deps.clock ?? systemOwnerClock;
  }

  /** Serves the owner contract on a newly authenticated connection. */
  open(identity: OwnerConnectionIdentity, transport: WireTransport): void {
    const connection: OwnerConnection = {
      id: randomUUID(),
      identity,
      transport,
      events: createEventStreamHost(ownerSessionContract.events),
      attached: undefined,
      closed: false,
      closeTimer: undefined,
    };
    this.connections.add(connection);
    const controller = this.connectionController(connection);
    const stopServing = serve(transport, controller);
    this.deps.logger.info('Owner link opened', {
      deviceId: identity.deviceId,
      via: identity.context.via,
      login: identity.context.login,
    });
    transport.onDisconnect(() => {
      stopServing();
      this.forget(connection);
      void controller.dispose?.();
    });
  }

  /** The attached owner client, if any. */
  attached(): AttachedOwner | null {
    return this.active?.attached?.owner ?? null;
  }

  isAttached(deviceId: string): boolean {
    return this.active?.identity.deviceId === deviceId;
  }

  connectionCount(deviceId: string): number {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.identity.deviceId === deviceId && !connection.closed) count += 1;
    }
    return count;
  }

  /** Closes every connection `predicate` selects. */
  closeWhere(predicate: (identity: OwnerConnectionIdentity) => boolean): void {
    for (const connection of [...this.connections]) {
      if (predicate(connection.identity)) this.close(connection);
    }
  }

  closeDevice(deviceId: string): void {
    this.closeWhere((identity) => identity.deviceId === deviceId);
  }

  closeAll(): void {
    this.closeWhere(() => true);
  }

  /** Tells the attached client the host is about to quit. */
  notifyHostQuitting(reason: 'update' | 'quit'): void {
    this.active?.events.emit(undefined, { type: 'host-quitting', reason });
  }

  dispose(): void {
    this.closeAll();
  }

  private connectionController(connection: OwnerConnection): Controller {
    const session = createController(ownerSessionContract, {
      attach: (input) => this.attach(connection, input),
      ping: () => ({ at: this.clock.now() }),
      events: connection.events,
      hostUpdateState: () => this.deps.hostUpdates?.state() ?? { status: 'unsupported' as const },
      requestHostUpdate: (request) =>
        this.deps.hostUpdates?.request(request) ??
        err({
          type: 'unsupported' as const,
          message: 'This host does not install updates on request.',
        }),
    });
    const { bridge, desktop } = this.deps;
    const isAttached = (): boolean => this.active === connection && !connection.closed;

    return {
      async call(path, input, meta) {
        const target = route(path);
        if (!target) throw unknownPath(path);
        if (!target.open && !isAttached()) throw notAttached(path);
        return await target.controller.call(target.path, input, meta);
      },
      resolveLive(topic) {
        const target = route(refIdOf(topic));
        if (!target) return refusedLiveSource(topic, unknownPath(topic));
        if (!target.open && !isAttached()) return refusedLiveSource(topic, notAttached(topic));
        return target.controller.resolveLive(rekey(topic, target.path));
      },
      acquireLive(topic) {
        const target = route(refIdOf(topic));
        if (!target) return refusedLiveLease(topic, unknownPath(topic));
        if (!target.open && !isAttached()) return refusedLiveLease(topic, notAttached(topic));
        return target.controller.acquireLive(rekey(topic, target.path));
      },
      async dispose() {
        connection.events.dispose();
        await session.dispose?.();
      },
    };

    function route(
      path: string
    ): { controller: Controller; path: string; open: boolean } | undefined {
      if (path.startsWith(SESSION_PREFIX)) {
        const inner = path.slice(SESSION_PREFIX.length);
        return { controller: session, path: inner, open: OPEN_SESSION_PATHS.has(inner) };
      }
      if (path.startsWith(BRIDGE_PREFIX)) {
        return { controller: bridge, path: path.slice(BRIDGE_PREFIX.length), open: false };
      }
      // The desktop filter takes the full path and enforces the routing table itself.
      if (path.startsWith(OWNER_DESKTOP_PREFIX)) return { controller: desktop, path, open: false };
      return undefined;
    }
  }

  private async attach(
    connection: OwnerConnection,
    input: OwnerAttachInput
  ): Promise<Result<OwnerAttachData, OwnerAttachError>> {
    if (connection.attached?.data && this.active === connection) {
      return ok(connection.attached.data);
    }
    if (!this.deps.enabled()) return err({ type: 'owner-disabled' });
    const hostBuild = await this.deps.hostBuild();
    if (connection.closed) return err({ type: 'owner-disabled' });
    if (!this.deps.enabled()) return err({ type: 'owner-disabled' });
    if (!this.deps.skipBuildCheck && !buildsCompatible(input.build, hostBuild)) {
      this.deps.logger.warn('Owner client refused: different build', {
        deviceId: connection.identity.deviceId,
        client: describeBuild(input.build),
        host: describeBuild(hostBuild),
      });
      return err({ type: 'build-mismatch', host: hostBuild });
    }

    const previous = this.active;
    const previousOwner = previous?.attached?.owner ?? null;
    if (previous && previous !== connection && previousOwner) {
      // The same device reconnecting (its old socket not yet known to be dead) takes over
      // without asking; a different device must ask for it.
      const sameDevice = previousOwner.deviceId === connection.identity.deviceId;
      if (!input.takeover && !sameDevice) {
        return err({
          type: 'busy',
          clientName: previousOwner.clientName,
          since: previousOwner.since,
        });
      }
      this.supersede(previous, input.clientName);
    }

    const owner: AttachedOwner = {
      sessionId: randomUUID(),
      deviceId: connection.identity.deviceId,
      clientName: input.clientName,
      clientPlatform: input.clientPlatform,
      since: this.clock.now(),
      context: connection.identity.context,
    };
    this.active = connection;
    connection.attached = { owner, data: null };
    // The window is suspended here, so the `brainEpoch` read below is current.
    this.deps.onActiveChanged(owner, previousOwner);
    const data: OwnerAttachData = {
      sessionId: owner.sessionId,
      hostBootId: this.deps.hostBootId,
      brainEpoch: this.deps.brainEpoch(),
      build: hostBuild,
      host: this.deps.hostInfo(),
    };
    connection.attached.data = data;
    this.deps.logger.info('Owner client attached', {
      sessionId: owner.sessionId,
      deviceId: owner.deviceId,
      deviceName: connection.identity.deviceName,
      clientName: owner.clientName,
      clientPlatform: owner.clientPlatform,
      via: owner.context.via,
      login: owner.context.login,
      takeover: previous !== undefined && previous !== connection,
    });
    return ok(data);
  }

  /** Detaches a connection in favour of another and closes it once the client was told. */
  private supersede(connection: OwnerConnection, by: string): void {
    const owner = connection.attached?.owner;
    this.deps.logger.info('Owner client superseded', {
      sessionId: owner?.sessionId,
      deviceId: connection.identity.deviceId,
      by,
    });
    if (this.active === connection) this.active = undefined;
    connection.events.emit(undefined, { type: 'superseded', by });
    connection.closeTimer = this.clock.setTimeout(
      () => this.close(connection),
      SUPERSEDE_CLOSE_DELAY_MS
    );
  }

  private close(connection: OwnerConnection): void {
    if (connection.closed) return;
    this.forget(connection);
    try {
      connection.transport.close?.();
    } catch {
      // Already torn down.
    }
  }

  /** Drops a connection's bookkeeping; detaches it if it was the attached one. */
  private forget(connection: OwnerConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.closeTimer !== undefined) this.clock.clearTimeout(connection.closeTimer);
    this.connections.delete(connection);
    if (this.active !== connection) return;
    const owner = connection.attached?.owner ?? null;
    this.active = undefined;
    this.deps.logger.info('Owner client detached', {
      sessionId: owner?.sessionId,
      deviceId: connection.identity.deviceId,
    });
    this.deps.onActiveChanged(null, owner);
  }
}

function refIdOf(topic: string): string {
  const keyAt = topic.indexOf('|');
  return keyAt === -1 ? topic : topic.slice(0, keyAt);
}

/** Replaces a topic's ref id with the routed one, keeping its key. */
function rekey(topic: string, routedRefId: string): string {
  const keyAt = topic.indexOf('|');
  return keyAt === -1 ? routedRefId : `${routedRefId}${topic.slice(keyAt)}`;
}

function unknownPath(path: string): WireError {
  return new WireError('NOT_FOUND', `Unknown owner path '${path}'`);
}

function notAttached(path: string): WireError {
  return new WireError('NOT_FOUND', `'${path}' needs an attached owner session`);
}
