import { randomUUID } from 'node:crypto';
import { err, ok, type Result, type Unsubscribe } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type { Controller } from '@emdash/wire/rpc';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import type { OwnerHostInfo } from '@core/features/client-mode/api/owner-contract';
import type {
  RemoteAccessError,
  RemoteAccessOwnerAccess,
  RemoteAccessOwnerSettingsPatch,
  RemoteAccessPairing,
} from '@core/features/remote-access/api/contract';
import type {
  EmitNotificationDelivery,
  NotificationSink,
} from '@core/services/notifications/api/ports';
import type { ExternalOpener } from '@main/host/external-opener';
import type { RemoteDevice, RemoteDeviceStore, RemoteOwnerAccessSettings } from '../device-store';
import type { RemoteAccessRoute, RemoteAccessUpgradeRoute } from '../http-server';
import { PairingCodes } from '../pairing';
import {
  createHostWindowSuspension,
  type HostWindowPort,
  type SuspensionClock,
} from './host-window-suspension';
import { evaluateOwnerPolicy, type OwnerRequestContext } from './owner-auth';
import { createOwnerBridge } from './owner-bridge';
import { createOwnerDesktopFilter } from './owner-desktop-filter';
import { createOwnerPairingRoute, ensureOwnerSetupToken } from './owner-pairing-route';
import {
  OwnerSessions,
  systemOwnerClock,
  type OwnerClock,
  type OwnerSessionDependencies,
} from './owner-session';
import {
  createOwnerUpgradeGate,
  createOwnerWireRoute,
  type OwnerUpgradeGate,
} from './owner-upgrade';
import { createOwnerTunnelRoute } from './tunnel-endpoint';

// The owner tier of remote access: a client-mode Maestro on another computer driving this app as
// its own. Everything here is inert until the person turns owner access on (it is off by default
// and stored in `remote-access.json`) and an owner device pairs and attaches:
//
// - the routes and upgrade routes return false while it is off, so the listener answers 404;
// - the window, notification sink and external opener are touched only on attach;
// - the setup-token file is created only once owner access is on.

/** Changes every time this process starts; an owner client reloads when it sees a new one. */
const HOST_BOOT_ID = randomUUID();

export type OwnerAccessDependencies = {
  store: RemoteDeviceStore;
  /** Directory for the setup-token file (the app's data directory). */
  dataDirectory: string;
  hostInfo(): OwnerHostInfo;
  /** Resolved on first attach, not at startup. */
  hostBuild(): Promise<BuildIdentity>;
  skipBuildCheck: boolean;
  /** The controller the app's own window is served by. */
  desktopController: Controller;
  notifications: {
    registerSink(sink: NotificationSink): () => void;
    emitDelivery: EmitNotificationDelivery;
  };
  /** Rebuilds the host's banner sink when the owner detaches. */
  createSystemSink?: (emitDelivery: EmitNotificationDelivery) => NotificationSink;
  window: HostWindowPort;
  setExternalOpener(opener: ExternalOpener | undefined): void;
  /** Something the status shows changed. */
  onChanged(): void;
  logger: Logger;
  /** The host's updater for `session.hostUpdateState` / `requestHostUpdate`; unsupported without. */
  hostUpdates?: OwnerSessionDependencies['hostUpdates'];
  clock?: OwnerClock & SuspensionClock;
  restoreDelayMs?: number;
  hostBootId?: string;
};

/** What the tunnel endpoint (`tunnel-endpoint.ts`) needs from the owner tier. */
export type OwnerTunnelAccess = {
  enabled(): boolean;
  gate: OwnerUpgradeGate;
  /** The device holds the attached owner session. */
  isAttached(deviceId: string): boolean;
  /**
   * Registers something to close when the device is revoked, its session ends, owner access is
   * turned off or narrowed past `context`, or the tier is disposed.
   */
  track(deviceId: string, context: OwnerRequestContext, close: () => void): Unsubscribe;
};

export type OwnerAccess = {
  /** HTTP routes: `/api/owner/pair` and `/api/owner/pairing-code`. */
  readonly routes: readonly RemoteAccessRoute[];
  /** Upgrade routes: `/owner/wire` and `/owner/tunnel`. */
  readonly upgradeRoutes: readonly RemoteAccessUpgradeRoute[];
  readonly operations: {
    setOwnerAccess(patch: RemoteAccessOwnerSettingsPatch): Promise<Result<void, RemoteAccessError>>;
    createOwnerPairingCode(): Promise<Result<RemoteAccessPairing, RemoteAccessError>>;
    cancelOwnerPairingCode(): void;
  };
  readonly tunnels: OwnerTunnelAccess;
  status(): RemoteAccessOwnerAccess;
  /** Live owner sockets the device holds (Wire links and tunnels). */
  connectionCount(deviceId: string): number;
  /** Closes the device's Wire links and tunnels (revocation). */
  closeDevice(deviceId: string): void;
  /** Closes every owner socket (the listener is stopping). */
  closeAll(): void;
  notifyHostQuitting(reason: 'update' | 'quit'): void;
  dispose(): Promise<void>;
};

type TrackedResource = { deviceId: string; context: OwnerRequestContext; close: () => void };

export function createOwnerAccess(deps: OwnerAccessDependencies): OwnerAccess {
  const clock = deps.clock ?? systemOwnerClock;
  const settings = (): RemoteOwnerAccessSettings => deps.store.current().ownerAccess;
  const enabled = (): boolean => settings().enabled;
  const pairing = new PairingCodes(() => clock.now());
  let pairingExpiry: unknown;
  const tracked = new Set<TrackedResource>();

  const suspension = createHostWindowSuspension({
    window: deps.window,
    logger: deps.logger,
    clock,
    restoreDelayMs: deps.restoreDelayMs,
  });
  const bridge = createOwnerBridge({
    notifications: deps.notifications,
    createSystemSink: deps.createSystemSink,
    setExternalOpener: deps.setExternalOpener,
    logger: deps.logger,
  });
  const sessions = new OwnerSessions({
    enabled,
    hostBuild: deps.hostBuild,
    skipBuildCheck: deps.skipBuildCheck,
    hostBootId: deps.hostBootId ?? HOST_BOOT_ID,
    hostInfo: deps.hostInfo,
    brainEpoch: () => suspension.brainEpoch(),
    bridge: bridge.controller,
    desktop: createOwnerDesktopFilter(deps.desktopController),
    hostUpdates: deps.hostUpdates,
    onActiveChanged: (active, previous) => {
      if (active && !previous) {
        suspension.onAttach();
        bridge.install();
      } else if (active) {
        // A takeover: the window stays down and the bridge stays in place.
        suspension.onAttach();
      } else {
        bridge.uninstall();
        suspension.onDetach();
        // Tunnels live only as long as an attached session.
        closeTracked(() => true);
      }
      deps.onChanged();
    },
    logger: deps.logger,
    clock,
  });
  const gate = createOwnerUpgradeGate({ store: deps.store, settings, logger: deps.logger });
  const tunnels: OwnerTunnelAccess = {
    enabled,
    gate,
    isAttached: (deviceId) => sessions.isAttached(deviceId),
    track(deviceId, context, close) {
      const resource: TrackedResource = { deviceId, context, close };
      tracked.add(resource);
      return () => tracked.delete(resource);
    },
  };

  if (enabled()) void prepareSetupToken();

  async function prepareSetupToken(): Promise<void> {
    try {
      await ensureOwnerSetupToken(deps.dataDirectory);
    } catch (error) {
      deps.logger.warn('Could not create the owner setup token', { error: String(error) });
    }
  }

  function issueCode(): RemoteAccessPairing {
    const issued = pairing.issue();
    clock.clearTimeout(pairingExpiry);
    pairingExpiry = clock.setTimeout(() => deps.onChanged(), issued.expiresAt - clock.now() + 50);
    deps.onChanged();
    return issued;
  }

  function closeTracked(predicate: (resource: TrackedResource) => boolean): void {
    for (const resource of [...tracked]) {
      if (!predicate(resource)) continue;
      tracked.delete(resource);
      try {
        resource.close();
      } catch {
        // Already closed.
      }
    }
  }

  function closeDevice(deviceId: string): void {
    sessions.closeDevice(deviceId);
    closeTracked((resource) => resource.deviceId === deviceId);
  }

  function closeAll(): void {
    sessions.closeAll();
    closeTracked(() => true);
  }

  /** Closes what the current settings no longer admit. */
  function enforceSettings(): void {
    const current = settings();
    if (!current.enabled) {
      closeAll();
      return;
    }
    const refused = (context: OwnerRequestContext) =>
      evaluateOwnerPolicy(context, current) !== null;
    sessions.closeWhere((identity) => refused(identity.context));
    closeTracked((resource) => refused(resource.context));
  }

  return {
    routes: [
      createOwnerPairingRoute({
        store: deps.store,
        pairing,
        settings,
        hostInfo: () => {
          const info = deps.hostInfo();
          return { hostId: info.id, hostName: info.name };
        },
        dataDirectory: deps.dataDirectory,
        issueCode,
        onPaired: (_device: RemoteDevice) => deps.onChanged(),
        logger: deps.logger,
      }),
    ],
    upgradeRoutes: [
      createOwnerWireRoute({
        enabled,
        gate,
        onConnection: ({ device, context }, transport) => {
          sessions.open({ deviceId: device.id, deviceName: device.name, context }, transport);
          transport.onDisconnect(() => deps.onChanged());
          deps.onChanged();
        },
      }),
      createOwnerTunnelRoute({ access: tunnels, logger: deps.logger }),
    ],
    operations: {
      async setOwnerAccess(patch) {
        const wasEnabled = enabled();
        await deps.store.updateOwnerAccess(normalizePatch(patch));
        const nowEnabled = enabled();
        if (nowEnabled && !wasEnabled) await prepareSetupToken();
        if (!nowEnabled) {
          pairing.cancel();
          clock.clearTimeout(pairingExpiry);
        }
        if (wasEnabled !== nowEnabled) {
          deps.logger.info(nowEnabled ? 'Owner access turned on' : 'Owner access turned off');
        }
        enforceSettings();
        deps.onChanged();
        return ok<void>();
      },
      async createOwnerPairingCode() {
        if (!enabled()) {
          return err({ type: 'invalid', message: 'Turn on full-access clients first.' });
        }
        return ok(issueCode());
      },
      cancelOwnerPairingCode() {
        pairing.cancel();
        clock.clearTimeout(pairingExpiry);
        deps.onChanged();
      },
    },
    tunnels,
    status() {
      const current = settings();
      const attached = current.enabled ? sessions.attached() : null;
      return {
        enabled: current.enabled,
        tailscaleOnly: current.tailscaleOnly,
        allowedLogins: [...current.allowedLogins],
        pairing: current.enabled ? (pairing.current() ?? null) : null,
        attachedClient: attached
          ? {
              deviceId: attached.deviceId,
              clientName: attached.clientName,
              clientPlatform: attached.clientPlatform,
              since: attached.since,
            }
          : null,
      };
    },
    connectionCount(deviceId) {
      let count = sessions.connectionCount(deviceId);
      for (const resource of tracked) if (resource.deviceId === deviceId) count += 1;
      return count;
    },
    closeDevice,
    closeAll,
    notifyHostQuitting: (reason) => sessions.notifyHostQuitting(reason),
    async dispose() {
      clock.clearTimeout(pairingExpiry);
      closeAll();
      suspension.dispose();
      await bridge.dispose();
    },
  };
}

/** Trims and de-duplicates the login allowlist; other fields pass through. */
function normalizePatch(patch: RemoteAccessOwnerSettingsPatch): RemoteAccessOwnerSettingsPatch {
  if (!patch.allowedLogins) return patch;
  const seen = new Set<string>();
  const allowedLogins: string[] = [];
  for (const login of patch.allowedLogins) {
    const trimmed = login.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    allowedLogins.push(trimmed);
  }
  return { ...patch, allowedLogins };
}
