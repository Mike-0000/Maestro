import { describe, expect, it, vi } from 'vitest';
import type { HostActivity } from './host-activity';
import {
  createUnattendedUpdatePolicy,
  runsUnderServiceManager,
  toHostUpdateState,
  type HostUpdateMode,
  type HostUpdaterPort,
  type PolicyClock,
} from './unattended-update-policy';
import type { UpdateState } from './update-service';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const MINUTE = 60_000;

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: PolicyClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };
  /** Advances time, firing due timers in order and letting their promises settle. */
  async function advance(ms: number): Promise<void> {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
    await flush();
  }
  return { clock, advance, pending: () => timers.size };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function fakeUpdater(initial: Partial<UpdateState> = {}) {
  const state: Pick<UpdateState, 'status' | 'availableVersion' | 'currentVersion'> = {
    status: 'idle',
    currentVersion: '1.0.0-maestro.202611010000',
    ...initial,
  };
  const updater: HostUpdaterPort & { state: typeof state; active: boolean } = {
    state,
    active: true,
    get isActive() {
      return this.active;
    },
    getState: () => ({ ...state }),
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(() => {
      state.status = 'downloading';
    }),
    quitAndInstall: vi.fn(() => {
      state.status = 'installing';
    }),
  };
  return updater;
}

function setup(
  options: {
    mode?: HostUpdateMode;
    updater?: ReturnType<typeof fakeUpdater>;
    activity?: () => Promise<HostActivity>;
    relaunchAfterInstall?: boolean;
  } = {}
) {
  let mode: HostUpdateMode = options.mode ?? 'manual';
  const time = fakeClock();
  const updater = options.updater ?? fakeUpdater();
  const activity = vi.fn(options.activity ?? (async () => ({ busy: false, detail: 'idle' })));
  const notifyHostQuitting = vi.fn();
  const policy = createUnattendedUpdatePolicy({
    mode: () => mode,
    updater,
    activity,
    notifyHostQuitting,
    relaunchAfterInstall: options.relaunchAfterInstall ?? false,
    logger: logger as never,
    clock: time.clock,
    pollIntervalMs: 30_000,
    idleWindowMs: 5 * MINUTE,
    quitNoticeMs: 2_000,
  });
  return {
    policy,
    updater,
    activity,
    notifyHostQuitting,
    time,
    setMode: (value: HostUpdateMode) => {
      mode = value;
    },
  };
}

describe('unattended update policy, manual mode (the local default)', () => {
  it('starts nothing and never touches the updater or the activity probe', async () => {
    const { policy, updater, activity, time } = setup({
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
    });
    policy.start();
    expect(time.pending()).toBe(0);
    await time.advance(60 * MINUTE);
    expect(activity).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    policy.dispose();
  });
});

describe('unattended update policy, when-idle', () => {
  it('downloads, waits five idle minutes, warns the client, then installs once', async () => {
    const { policy, updater, notifyHostQuitting, time } = setup({
      mode: 'when-idle',
      updater: fakeUpdater({ status: 'available', availableVersion: '1.0.1' }),
    });
    policy.start();
    await time.advance(30_000);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    updater.state.status = 'downloaded';
    // First idle reading starts the window; the install waits for five minutes of idle.
    await time.advance(30_000);
    await time.advance(4 * MINUTE);
    expect(notifyHostQuitting).not.toHaveBeenCalled();
    await time.advance(MINUTE);
    expect(notifyHostQuitting).toHaveBeenCalledExactlyOnceWith('update');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await time.advance(2_000);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith({ relaunch: false });

    await time.advance(30 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(notifyHostQuitting).toHaveBeenCalledTimes(1);
    policy.dispose();
  });

  it('postpones while the host is busy and restarts the idle window after it', async () => {
    let busy = true;
    const { policy, updater, time } = setup({
      mode: 'when-idle',
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
      activity: async () =>
        busy ? { busy: true, detail: '1 working agent' } : { busy: false, detail: 'idle' },
    });
    policy.start();
    await time.advance(60 * MINUTE);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    busy = false;
    await time.advance(3 * MINUTE);
    busy = true;
    await time.advance(30_000);
    busy = false;
    await time.advance(4 * MINUTE + 30_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await time.advance(2 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    policy.dispose();
  });

  it('treats an activity read that fails as busy', async () => {
    const { policy, updater, time } = setup({
      mode: 'when-idle',
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
      activity: async () => {
        throw new Error('worker gone');
      },
    });
    policy.start();
    await time.advance(30 * MINUTE);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    policy.dispose();
  });

  it('lets the installer relaunch when no service manager restarts the app', async () => {
    const { policy, updater, time } = setup({
      mode: 'when-idle',
      relaunchAfterInstall: true,
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
    });
    policy.start();
    await time.advance(10 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(undefined);
    policy.dispose();
  });

  it('retries after an install that never quit', async () => {
    const { policy, updater, time } = setup({
      mode: 'when-idle',
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
    });
    policy.start();
    await time.advance(6 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    // The update service rolled the stuck install back.
    updater.state.status = 'downloaded';
    await time.advance(2 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    await time.advance(10 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
    policy.dispose();
  });

  it('stops after dispose', async () => {
    const { policy, updater, time } = setup({
      mode: 'when-idle',
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
    });
    policy.start();
    policy.dispose();
    await time.advance(60 * MINUTE);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('host update requests from an owner client', () => {
  it('installs right away for `now`, skipping the idle wait', async () => {
    const { policy, updater, notifyHostQuitting, activity, time } = setup({
      updater: fakeUpdater({ status: 'downloaded', availableVersion: '1.0.1' }),
      activity: async () => ({ busy: true, detail: '3 working agents' }),
    });
    expect(await policy.request({ when: 'now' })).toEqual({ success: true, data: undefined });
    await time.advance(0);
    expect(notifyHostQuitting).toHaveBeenCalledWith('update');
    await time.advance(2_000);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(activity).not.toHaveBeenCalled();
    policy.dispose();
  });

  it('arms the idle wait for `idle` even in manual mode', async () => {
    const { policy, updater, time } = setup({
      updater: fakeUpdater({ status: 'available', availableVersion: '1.0.1' }),
    });
    expect((await policy.request({ when: 'idle' })).success).toBe(true);
    await time.advance(0);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    updater.state.status = 'downloaded';
    await time.advance(6 * MINUTE);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    policy.dispose();
  });

  it('checks the feed first and reports when the host is current', async () => {
    const { policy, updater } = setup();
    const result = await policy.request({ when: 'now' });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      error: {
        type: 'no-update',
        message: 'The host already runs the newest release (1.0.0-maestro.202611010000).',
      },
    });
    policy.dispose();
  });

  it('finds an update through the check and proceeds', async () => {
    const updater = fakeUpdater();
    vi.mocked(updater.checkForUpdates).mockImplementation(async () => {
      updater.state.status = 'available';
      updater.state.availableVersion = '1.0.1';
    });
    const { policy } = setup({ updater });
    expect((await policy.request({ when: 'idle' })).success).toBe(true);
    policy.dispose();
  });

  it('is unsupported when the updater is off', async () => {
    const updater = fakeUpdater();
    updater.active = false;
    const { policy } = setup({ updater, mode: 'when-idle' });
    expect(policy.state()).toEqual({ status: 'unsupported' });
    expect(await policy.request({ when: 'now' })).toMatchObject({
      success: false,
      error: { type: 'unsupported' },
    });
    policy.dispose();
  });
});

describe('host update state', () => {
  it('maps the update service states onto the owner contract', () => {
    expect(toHostUpdateState({ status: 'idle' })).toEqual({ status: 'idle' });
    expect(toHostUpdateState({ status: 'checking' })).toEqual({ status: 'checking' });
    expect(toHostUpdateState({ status: 'available', availableVersion: '2' })).toEqual({
      status: 'available',
      version: '2',
    });
    expect(toHostUpdateState({ status: 'installing', availableVersion: '2' })).toEqual({
      status: 'downloaded',
      version: '2',
    });
    expect(toHostUpdateState({ status: 'error', availableVersion: '2' })).toEqual({
      status: 'available',
      version: '2',
    });
    expect(toHostUpdateState({ status: 'error' })).toEqual({ status: 'idle' });
  });
});

describe('service manager detection', () => {
  it('is on only when the host service wrapper set MAESTRO_HOST_SERVICE=1', () => {
    expect(runsUnderServiceManager({})).toBe(false);
    expect(runsUnderServiceManager({ MAESTRO_HOST_SERVICE: '0' })).toBe(false);
    expect(runsUnderServiceManager({ MAESTRO_HOST_SERVICE: '1' })).toBe(true);
  });
});
