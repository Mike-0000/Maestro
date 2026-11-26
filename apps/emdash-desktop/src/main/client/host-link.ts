import { err, ok, type Result, type Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { systemClock, type Clock, type TimerHandle } from '@emdash/shared/scheduling';
import { WebSocketHandshakeError } from '@emdash/wire/node';
import {
  client,
  connect,
  reconnectingTransport,
  WireError,
  type Connection,
  type ContractClient,
  type ReconnectingTransport,
  type WireTransport,
} from '@emdash/wire/rpc';
import { cell, type Readable } from '@emdash/wire/state';
import { z } from 'zod';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import type {
  ClientSessionBlockedReason,
  ClientSessionStatus,
} from '@core/features/client-mode/api/client-session-contract';
import {
  hostUpdateErrorSchema,
  type HostUpdateError,
  type HostUpdateRequest,
} from '@core/features/client-mode/api/host-update';
import {
  ownerAttachDataSchema,
  ownerAttachErrorSchema,
  ownerHostWireContract,
  type OwnerAttachData,
  type OwnerAttachError,
  type OwnerAttachInput,
} from '@core/features/client-mode/api/owner-contract';
import { v8MessageTransport, type V8MessagePipe } from '@main/owner-link/v8-transport';
import type { ClientConnection } from './connection-store';

// The client's link to its host: one Wire connection over a reconnecting transport whose every
// physical connection is a fresh `/owner/wire` WebSocket that has passed `session.attach`. Calls
// made while the link is down are held by the Wire connection (no call deadline of its own: the
// renderer's own deadlines and cancellation govern) and flushed once the next attach succeeds;
// live topics re-attach by themselves.
//
// A refusal that retrying cannot repair (a revoked credential, a different build, owner access
// off, another client attached) blocks the link instead of failing it for good: the next dial
// waits until the user asks for it (`retryNow`, `takeOver`), so one connection serves the whole
// life of the process.

export type OwnerHostClient = ContractClient<typeof ownerHostWireContract>;

export type HostLinkDeps = {
  build: BuildIdentity;
  clientName: string;
  clientPlatform: string;
  /** Opens one physical connection to `/owner/wire`. */
  dial(connection: ClientConnection, signal: AbortSignal): Promise<V8MessagePipe>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The host process restarted, or its own window ran agents meanwhile: reload the renderer. */
  onHostChanged?(): void;
  clock?: Clock;
  /** Delays between failed dials; the last repeats. */
  backoffMs?: number[];
  attachTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
};

export type HostAttachedEvent = { data: OwnerAttachData; first: boolean };

export type HostLink = {
  readonly status: Readable<ClientSessionStatus>;
  /** The status as it is now. */
  current(): ClientSessionStatus;
  /** True once `start` was called with a connection. */
  readonly started: boolean;
  /** Starts dialing `connection`, or reports `unpaired` for null. Only the first call counts. */
  start(connection: ClientConnection | null): void;
  /** The host's client; settles once the first attach succeeded and never rejects. */
  ready(): Promise<OwnerHostClient>;
  /** Every successful attach, after the link is usable. */
  onAttached(listener: (event: HostAttachedEvent) => void): Unsubscribe;
  /** Leaves a blocked state, skips the reconnect backoff, and dials now. */
  retryNow(): void;
  /** Like `retryNow`, attaching with `takeover: true`. */
  takeOver(): void;
  /** The computer woke up or the network changed: check the link now. */
  probe(): void;
  requestHostUpdate(input: HostUpdateRequest): Promise<Result<void, HostUpdateError>>;
  close(): void;
};

/** `session.attach` in `ownerHostWireContract`: procedure ids are their contract paths. */
const ATTACH_PATH = 'session.attach';
const REQUEST_HOST_UPDATE_PATH = 'session.requestHostUpdate';
const DEFAULT_BACKOFF_MS = [250, 1_000, 2_000, 5_000, 10_000];
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_PING_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

const hostUpdateResultSchema = z.union([
  z.object({ success: z.literal(true) }),
  z.object({ success: z.literal(false), error: hostUpdateErrorSchema }),
]);

const attachResultSchema = z.union([
  z.object({ success: z.literal(true), data: ownerAttachDataSchema }),
  z.object({ success: z.literal(false), error: ownerAttachErrorSchema }),
]);

/** Thrown by a dial the link has turned into a blocked state; never retried until released. */
class LinkBlockedError extends Error {
  constructor(readonly reason: ClientSessionBlockedReason) {
    super(`Owner link blocked: ${reason}`);
    this.name = 'LinkBlockedError';
  }
}

const INITIAL_STATUS: ClientSessionStatus = {
  phase: 'unpaired',
  host: null,
  blocked: null,
  attempt: 0,
  lastError: null,
  connectedAt: null,
  latencyMs: null,
};

export function createHostLink(deps: HostLinkDeps): HostLink {
  const baseClock = deps.clock ?? systemClock;
  const wake = wakeableClock(baseClock);
  const attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimeoutMs = deps.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const status = cell<ClientSessionStatus>(INITIAL_STATUS);
  // The cell has no public read; this mirror is what the link itself decides from.
  let current: ClientSessionStatus = INITIAL_STATUS;
  const lifetime = new AbortController();
  const attachedListeners = new Set<(event: HostAttachedEvent) => void>();

  let connection: ClientConnection | null = null;
  let started = false;
  let transport: ReconnectingTransport | undefined;
  let wire: Connection | undefined;
  let hostClient: OwnerHostClient | undefined;
  let physical: WireTransport | null = null;
  let pendingAttach: OwnerAttachData | null = null;
  let lastAttach: OwnerAttachData | null = null;
  let takeoverNext = false;
  let blockedRelease: (() => void) | null = null;
  let pingTimer: TimerHandle | undefined;
  let eventsSubscribed = false;

  let resolveReady!: (value: OwnerHostClient) => void;
  const readyPromise = new Promise<OwnerHostClient>((resolve) => {
    resolveReady = resolve;
  });

  const update = (patch: Partial<ClientSessionStatus>): void => {
    current = { ...current, ...patch };
    status.set(current);
  };

  const block = (
    reason: ClientSessionBlockedReason,
    extra: Omit<NonNullable<ClientSessionStatus['blocked']>, 'reason'> = {}
  ): void => {
    deps.log.warn('client link blocked', { reason, detail: extra.detail });
    update({
      phase: 'blocked',
      blocked: { reason, ...extra },
      connectedAt: null,
      latencyMs: null,
    });
  };

  const isBlocked = (): boolean => current.phase === 'blocked';

  /** Resolves once the link is not blocked; rejects when the link is closed. */
  const waitUntilUnblocked = (): Promise<void> => {
    if (!isBlocked()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('Owner link closed'));
      lifetime.signal.addEventListener('abort', onAbort, { once: true });
      blockedRelease = () => {
        lifetime.signal.removeEventListener('abort', onAbort);
        blockedRelease = null;
        resolve();
      };
    });
  };

  const release = (): void => {
    if (isBlocked()) {
      update({
        phase: lastAttach ? 'reconnecting' : 'connecting',
        blocked: null,
        attempt: 0,
        lastError: null,
      });
    }
    blockedRelease?.();
    wake.wake();
  };

  const recordFailure = (message: string): void => {
    if (isBlocked()) return;
    const previous = current;
    update({
      phase: lastAttach ? 'reconnecting' : 'connecting',
      attempt: previous.attempt + 1,
      lastError: message,
      connectedAt: null,
      latencyMs: null,
    });
  };

  const connectOnce = async (): Promise<WireTransport> => {
    await waitUntilUnblocked();
    const target = connection;
    if (!target) throw new Error('Owner link has no host');
    let pipe: V8MessagePipe;
    try {
      pipe = await deps.dial(target, lifetime.signal);
    } catch (error) {
      throw classifyDialFailure(error, target);
    }
    const next = v8MessageTransport(pipe);
    let attached: Result<OwnerAttachData, OwnerAttachError>;
    try {
      attached = await attachOver(next, {
        build: deps.build,
        clientName: deps.clientName,
        clientPlatform: deps.clientPlatform,
        takeover: takeoverNext,
      });
    } catch (error) {
      next.close?.();
      const message = `The host did not complete the handshake: ${describe(error)}`;
      recordFailure(message);
      throw new Error(message, { cause: error });
    }
    if (!attached.success) {
      next.close?.();
      throw blockForAttachError(attached.error);
    }
    takeoverNext = false;
    pendingAttach = attached.data;
    physical = next;
    next.onDisconnect(() => {
      if (physical === next) physical = null;
    });
    return next;
  };

  const classifyDialFailure = (error: unknown, target: ClientConnection): Error => {
    if (lifetime.signal.aborted) return new Error('Owner link closed');
    if (error instanceof WebSocketHandshakeError) {
      if (error.statusCode === 401) {
        block('revoked', {
          detail: 'The host no longer accepts this client. Pair it again with a new code.',
        });
        return new LinkBlockedError('revoked');
      }
      if (error.statusCode === 403) {
        block('tailscale-required', {
          detail: target.cfAccess
            ? 'The host or a gateway in front of it turned this client away. Check the Cloudflare Access credentials, or connect through Tailscale.'
            : 'The host only accepts full-access clients over Tailscale. Connect to its Tailscale address.',
        });
        return new LinkBlockedError('tailscale-required');
      }
      if (error.statusCode === 404) {
        block('owner-disabled', {
          detail: 'Owner access is turned off on the host.',
        });
        return new LinkBlockedError('owner-disabled');
      }
    }
    const message = describeDialError(error);
    recordFailure(message);
    return error instanceof Error ? error : new Error(message);
  };

  const blockForAttachError = (error: OwnerAttachError): Error => {
    switch (error.type) {
      case 'build-mismatch':
        block('build-mismatch', { hostBuild: error.host, clientBuild: deps.build });
        break;
      case 'owner-disabled':
        block('owner-disabled', { detail: 'Owner access is turned off on the host.' });
        break;
      case 'busy':
        block('busy', { busyClientName: error.clientName });
        break;
    }
    return new LinkBlockedError(blockedReasonOf(error));
  };

  const attachOver = async (
    physicalTransport: WireTransport,
    input: OwnerAttachInput
  ): Promise<Result<OwnerAttachData, OwnerAttachError>> => {
    // A short-lived logical connection on the new physical one: disposing it leaves the
    // transport open for the long-lived connection the reconnecting transport hands it to.
    const handshake = connect(physicalTransport, {
      callTimeoutMs: attachTimeoutMs,
      clock: baseClock,
    });
    try {
      const raw = await handshake.call(ATTACH_PATH, input);
      const parsed = attachResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error('unexpected attach reply');
      return parsed.data.success ? ok(parsed.data.data) : err(parsed.data.error);
    } finally {
      handshake.dispose();
    }
  };

  const onReconnected = (): void => {
    const data = pendingAttach;
    pendingAttach = null;
    if (!data || !hostClient) return;
    const previous = lastAttach;
    lastAttach = data;
    const target = connection;
    update({
      phase: 'connected',
      blocked: null,
      attempt: 0,
      lastError: null,
      connectedAt: baseClock.now(),
      host: {
        url: target?.url ?? '',
        id: data.host.id,
        name: data.host.name,
        platform: data.host.platform,
      },
    });
    deps.log.info('client link attached', {
      sessionId: data.sessionId,
      host: data.host.name,
      reattach: previous !== null,
    });
    if (
      previous &&
      (previous.hostBootId !== data.hostBootId || previous.brainEpoch !== data.brainEpoch)
    ) {
      deps.log.info('client link: host changed since the last attach; reloading the renderer', {
        hostRestarted: previous.hostBootId !== data.hostBootId,
      });
      deps.onHostChanged?.();
    }
    resolveReady(hostClient);
    subscribeSessionEvents(hostClient);
    schedulePing();
    for (const listener of [...attachedListeners]) {
      try {
        listener({ data, first: previous === null });
      } catch (error) {
        deps.log.warn('client link attach listener failed', { error: describe(error) });
      }
    }
  };

  const onDisconnected = (): void => {
    void pingTimer?.dispose();
    pingTimer = undefined;
    if (isBlocked()) return;
    update({
      phase: lastAttach ? 'reconnecting' : 'connecting',
      connectedAt: null,
      latencyMs: null,
    });
  };

  const subscribeSessionEvents = (owner: OwnerHostClient): void => {
    if (eventsSubscribed) return;
    eventsSubscribed = true;
    void owner.session.events
      .subscribe(undefined, {
        onEvent: (event) => {
          if (event.type === 'superseded') {
            block('superseded', {
              detail: `Another client took over: ${event.by}`,
              busyClientName: event.by,
            });
            physical?.close?.();
            return;
          }
          update({
            lastError:
              event.reason === 'update'
                ? 'The host is restarting to install an update.'
                : 'The host is quitting.',
          });
        },
        signal: lifetime.signal,
      })
      .catch((error: unknown) => {
        eventsSubscribed = false;
        deps.log.warn('client link: session events unavailable', { error: describe(error) });
      });
  };

  const ping = async (timeoutMs: number): Promise<void> => {
    const owner = hostClient;
    const probed = physical;
    if (!owner || !probed || current.phase !== 'connected') return;
    const startedAt = baseClock.now();
    try {
      await owner.session.ping(undefined, { timeoutMs });
      if (physical === probed && current.phase === 'connected') {
        update({ latencyMs: Math.max(0, baseClock.now() - startedAt) });
      }
    } catch (error) {
      if (lifetime.signal.aborted || physical !== probed) return;
      deps.log.warn('client link: ping failed; dropping the connection', {
        error: describe(error),
      });
      probed.close?.();
    }
  };

  const schedulePing = (): void => {
    void pingTimer?.dispose();
    if (pingIntervalMs <= 0) return;
    pingTimer = baseClock.schedule(
      pingIntervalMs,
      () => {
        void ping(pingTimeoutMs).finally(() => {
          if (current.phase === 'connected' && !lifetime.signal.aborted) schedulePing();
        });
      },
      { unref: true }
    );
  };

  const requestHostUpdateUnattached = async (
    input: HostUpdateRequest
  ): Promise<Result<void, HostUpdateError>> => {
    const target = connection;
    if (!target) return err({ type: 'failed', message: 'This client is not paired with a host.' });
    const pipe = await deps.dial(target, lifetime.signal);
    const side = v8MessageTransport(pipe);
    const call = connect(side, { callTimeoutMs: 30_000, clock: baseClock });
    try {
      const raw = await call.call(REQUEST_HOST_UPDATE_PATH, input);
      const parsed = hostUpdateResultSchema.safeParse(raw);
      if (!parsed.success) throw new Error('unexpected reply to the update request');
      return parsed.data.success ? ok() : err(parsed.data.error);
    } finally {
      call.dispose();
      side.close?.();
    }
  };

  return {
    status,
    current: () => current,
    get started() {
      return started;
    },

    start(initial) {
      if (started || lifetime.signal.aborted) return;
      if (!initial) {
        update({ ...INITIAL_STATUS });
        return;
      }
      started = true;
      connection = initial;
      update({
        phase: 'connecting',
        host: { url: initial.url, id: initial.hostId, name: initial.hostName },
        blocked: null,
        attempt: 0,
        lastError: null,
      });
      transport = reconnectingTransport(connectOnce, {
        clock: wake.clock,
        backoffMs: deps.backoffMs ?? DEFAULT_BACKOFF_MS,
        // Blocking refusals wait inside the next dial; every other failure is retried.
        shouldRetry: () => !lifetime.signal.aborted,
      });
      wire = connect(transport, { callTimeoutMs: 0, clock: baseClock });
      hostClient = client(ownerHostWireContract, wire);
      // After the connection's own listeners: it flushes held calls and re-attaches its topics
      // first, so a subscription made in `onReconnected` is not mistaken for a stale one.
      transport.onReconnect(onReconnected);
      transport.onDisconnect(onDisconnected);
    },

    ready: () => readyPromise,

    onAttached(listener) {
      attachedListeners.add(listener);
      return () => attachedListeners.delete(listener);
    },

    retryNow() {
      release();
    },

    takeOver() {
      takeoverNext = true;
      release();
    },

    probe() {
      wake.wake();
      void ping(PROBE_TIMEOUT_MS);
    },

    async requestHostUpdate(input) {
      const owner = hostClient;
      try {
        if (owner && current.phase === 'connected') {
          return await owner.session.requestHostUpdate(input, { timeoutMs: 30_000 });
        }
        // Not attached (for example blocked on a build mismatch): `session.*` answers before
        // attach, so ask over a connection of its own.
        return await requestHostUpdateUnattached(input);
      } catch (error) {
        return err({ type: 'failed', message: describe(error) });
      }
    },

    close() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      void pingTimer?.dispose();
      wire?.dispose();
      transport?.close();
      attachedListeners.clear();
    },
  };
}

function blockedReasonOf(error: OwnerAttachError): ClientSessionBlockedReason {
  return error.type;
}

function describe(error: unknown): string {
  if (error instanceof WireError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function describeDialError(error: unknown): string {
  if (error instanceof WebSocketHandshakeError && error.statusCode !== undefined) {
    if (error.statusCode >= 300 && error.statusCode < 400) {
      return 'A gateway in front of the host redirected this client (for example to a sign-in page).';
    }
    return `The host refused the connection (HTTP ${error.statusCode}).`;
  }
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return `Could not reach the host: ${cause.message}`;
  return `Could not reach the host: ${error.message}`;
}

/**
 * A clock whose sleeps can be cut short, so "Retry now" and a wake from sleep skip the rest of
 * the reconnect backoff instead of waiting it out.
 */
function wakeableClock(base: Clock): { clock: Clock; wake(): void } {
  const sleepers = new Set<() => void>();
  return {
    clock: {
      now: () => base.now(),
      schedule: (delayMs, callback, options) => base.schedule(delayMs, callback, options),
      sleep(delayMs, options) {
        return new Promise<void>((resolve, reject) => {
          const done = (): void => {
            sleepers.delete(done);
            resolve();
          };
          sleepers.add(done);
          base.sleep(delayMs, options).then(done, (error: unknown) => {
            sleepers.delete(done);
            reject(error);
          });
        });
      },
    },
    wake() {
      for (const sleeper of [...sleepers]) sleeper();
    },
  };
}
