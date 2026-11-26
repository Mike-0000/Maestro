import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import type {
  HostUpdateError,
  HostUpdateRequest,
  HostUpdateState,
} from '@core/features/client-mode/api/host-update';
import type { HostActivity } from './host-activity';
import type { UpdateState } from './update-service';

// Installs updates on a host nobody sits at (the Linux VM a client-mode Maestro drives), where
// nobody would ever click Download and Restart.
//
// It does nothing unless one of two things switched it on:
// - `hostUpdates.mode` is `when-idle` in `remote-access.json` (off, `manual`, by default); or
// - an owner client asked for a host update (`session.requestHostUpdate`).
// While on, it downloads an available update, waits until the host has been idle for five
// minutes (no working agent or chat, no starting automation run), warns the attached client that
// the host is quitting, then quits and installs. A request with `when: 'now'` skips the wait.
// The ordinary local app never arms it, so its updater behaves exactly as before.

export const DEFAULT_IDLE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
/** Time for the `host-quitting` event to reach the client before the process goes away. */
const DEFAULT_QUIT_NOTICE_MS = 2_000;
/** After this long without quitting, an install is considered failed and may be retried. */
const INSTALL_RETRY_AFTER_MS = 3 * 60 * 1000;

export type HostUpdateMode = 'manual' | 'when-idle';

/** Set to `1` by the host service wrapper (`scripts/host/maestro-host-run.sh`). */
export const HOST_SERVICE_ENV = 'MAESTRO_HOST_SERVICE';

/** True when a service manager restarts the app after it quits (the systemd host unit). */
export function runsUnderServiceManager(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return env[HOST_SERVICE_ENV] === '1';
}

/** The parts of `UpdateService` the policy uses. */
export type HostUpdaterPort = {
  readonly isActive: boolean;
  getState(): Pick<UpdateState, 'status' | 'availableVersion' | 'currentVersion'>;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): void;
  quitAndInstall(options?: { relaunch?: boolean }): void;
};

export type PolicyClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemClock: PolicyClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type UnattendedUpdatePolicyDependencies = {
  /** Read on every check, so the standing mode is whatever the settings file says now. */
  mode(): HostUpdateMode;
  updater: HostUpdaterPort;
  activity(): Promise<HostActivity>;
  /** Warns the attached owner client; a no-op when none is attached. */
  notifyHostQuitting(reason: 'update'): void;
  /**
   * False when a service manager restarts the app (systemd on the Linux host): the installer then
   * leaves the restart to it, so the new build starts once and with the service's flags.
   */
  relaunchAfterInstall: boolean;
  logger: Logger;
  clock?: PolicyClock;
  idleWindowMs?: number;
  pollIntervalMs?: number;
  quitNoticeMs?: number;
};

export type UnattendedUpdatePolicy = {
  /** Starts the standing policy when the mode is `when-idle`; otherwise does nothing. */
  start(): void;
  /** The host's updater as an owner client sees it. */
  state(): HostUpdateState;
  /** An owner client asks the host to update, once idle or right away. */
  request(request: HostUpdateRequest): Promise<Result<void, HostUpdateError>>;
  dispose(): void;
};

type Pending = 'idle' | 'now';

export function createUnattendedUpdatePolicy(
  deps: UnattendedUpdatePolicyDependencies
): UnattendedUpdatePolicy {
  const clock = deps.clock ?? systemClock;
  const idleWindowMs = deps.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const quitNoticeMs = deps.quitNoticeMs ?? DEFAULT_QUIT_NOTICE_MS;
  const { updater, logger } = deps;

  let requested: Pending | null = null;
  let timer: unknown;
  let ticking = false;
  let tickAgain = false;
  let idleSince: number | null = null;
  let lastBusyDetail: string | null = null;
  let installStartedAt: number | null = null;
  let disposed = false;

  const armed = (): boolean => requested !== null || deps.mode() === 'when-idle';

  function schedule(ms: number): void {
    clock.clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void tick();
    }, ms);
  }

  async function tick(): Promise<void> {
    if (disposed) return;
    if (ticking) {
      tickAgain = true;
      return;
    }
    ticking = true;
    try {
      await step();
    } catch (error) {
      logger.warn('Unattended host update check failed', { error: String(error) });
    } finally {
      ticking = false;
    }
    if (disposed || !armed()) return;
    if (tickAgain) {
      tickAgain = false;
      schedule(0);
    } else {
      schedule(pollIntervalMs);
    }
  }

  async function step(): Promise<void> {
    if (!armed() || !updater.isActive) return;
    const current = updater.getState();

    if (installStartedAt !== null) {
      // The app normally quits long before this; the update service rolls a stuck install back
      // to `downloaded`, after which another attempt may start.
      if (current.status !== 'downloaded') return;
      if (clock.now() - installStartedAt < INSTALL_RETRY_AFTER_MS) return;
      installStartedAt = null;
    }

    if (
      current.status === 'available' ||
      (current.status === 'error' && current.availableVersion)
    ) {
      idleSince = null;
      logger.info('Unattended host update: downloading', { version: current.availableVersion });
      updater.downloadUpdate();
      return;
    }
    if (current.status !== 'downloaded') {
      idleSince = null;
      return;
    }

    if (requested === 'now') {
      install(current.availableVersion, 'requested now');
      return;
    }
    const activity = await readActivity();
    if (disposed) return;
    const now = clock.now();
    if (activity.busy) {
      idleSince = null;
      if (activity.detail !== lastBusyDetail) {
        logger.info('Unattended host update waits for the host to be idle', {
          version: current.availableVersion,
          busy: activity.detail,
        });
        lastBusyDetail = activity.detail;
      }
      return;
    }
    lastBusyDetail = null;
    idleSince ??= now;
    if (now - idleSince >= idleWindowMs) install(current.availableVersion, 'idle');
  }

  async function readActivity(): Promise<HostActivity> {
    try {
      return await deps.activity();
    } catch (error) {
      return { busy: true, detail: `activity could not be read: ${String(error)}` };
    }
  }

  function install(version: string | undefined, reason: string): void {
    installStartedAt = clock.now();
    idleSince = null;
    logger.info('Unattended host update: quitting to install', {
      version,
      reason,
      relaunch: deps.relaunchAfterInstall,
    });
    deps.notifyHostQuitting('update');
    clock.setTimeout(() => {
      if (disposed) return;
      try {
        updater.quitAndInstall(deps.relaunchAfterInstall ? undefined : { relaunch: false });
      } catch (error) {
        installStartedAt = null;
        logger.warn('Unattended host update could not install', { error: String(error) });
      }
    }, quitNoticeMs);
  }

  return {
    start() {
      if (disposed || deps.mode() !== 'when-idle') return;
      logger.info('Unattended host updates are on: updates install once the host is idle', {
        idleMinutes: Math.round(idleWindowMs / 60_000),
        updaterActive: updater.isActive,
      });
      schedule(pollIntervalMs);
    },

    state() {
      if (!updater.isActive) return { status: 'unsupported' };
      return toHostUpdateState(updater.getState());
    },

    async request(request) {
      if (disposed || !updater.isActive) {
        return err({
          type: 'unsupported',
          message: 'This host cannot update itself (a development build, or no update feed).',
        });
      }
      if (installStartedAt === null && !hasUpdate(updater.getState())) {
        try {
          await updater.checkForUpdates();
        } catch (error) {
          return err({ type: 'failed', message: `Could not check for updates: ${String(error)}` });
        }
        const checked = updater.getState();
        if (!hasUpdate(checked)) {
          return err({
            type: 'no-update',
            message: `The host already runs the newest release (${checked.currentVersion}).`,
          });
        }
      }
      requested = request.when === 'now' || requested === 'now' ? 'now' : 'idle';
      logger.info('Owner client requested a host update', { when: request.when });
      void tick();
      return ok();
    },

    dispose() {
      disposed = true;
      clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}

function hasUpdate(state: Pick<UpdateState, 'status' | 'availableVersion'>): boolean {
  switch (state.status) {
    case 'available':
    case 'downloading':
    case 'downloaded':
    case 'installing':
      return true;
    case 'error':
      return Boolean(state.availableVersion);
    default:
      return false;
  }
}

export function toHostUpdateState(
  state: Pick<UpdateState, 'status' | 'availableVersion'>
): HostUpdateState {
  const version = state.availableVersion ? { version: state.availableVersion } : {};
  switch (state.status) {
    case 'installing':
      return { status: 'downloaded', ...version };
    case 'error':
      return state.availableVersion ? { status: 'available', ...version } : { status: 'idle' };
    case 'idle':
      return { status: 'idle' };
    default:
      return { status: state.status, ...version };
  }
}
