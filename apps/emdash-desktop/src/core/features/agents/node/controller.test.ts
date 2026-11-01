import { hostDependenciesContract } from '@emdash/core/services/host-dependencies/node';
import { err, ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentOperations } from './controller';

const runRuntimeLiveJob = vi.hoisted(() => vi.fn());

vi.mock('@core/services/runtime-clients/node/live-job', () => ({
  runRuntimeLiveJob,
}));

describe('createAgentOperations update routing', () => {
  beforeEach(() => {
    runRuntimeLiveJob.mockReset();
    runRuntimeLiveJob.mockResolvedValue(err({ type: 'no-update-command', id: 'codex' }));
  });

  it('routes package-manager updates through the install command job', async () => {
    const runInstallCommand = {};
    const manager = { runInstallCommand };
    const operations = createOperations();

    await operations.update('codex', undefined, 'npm', true, manager as never);

    expect(runRuntimeLiveJob).toHaveBeenCalledWith(
      hostDependenciesContract.runInstallCommand,
      runInstallCommand,
      {
        id: 'codex',
        method: 'npm',
        elevate: true,
        commandKind: 'update',
      },
      undefined,
      { signal: undefined }
    );
  });

  it('routes cli updates through the unelevated self-update job', async () => {
    const runSelfUpdateCommand = {};
    const manager = { runSelfUpdateCommand };
    const operations = createOperations();

    await operations.update('claude', undefined, undefined, undefined, manager as never);

    expect(runRuntimeLiveJob).toHaveBeenCalledWith(
      hostDependenciesContract.runSelfUpdateCommand,
      runSelfUpdateCommand,
      { id: 'claude' },
      undefined,
      { signal: undefined }
    );
  });

  it('forwards cancellation and progress context to the runtime job', async () => {
    const runInstallCommand = {};
    const manager = { runInstallCommand };
    const operations = createOperations();
    const signal = new AbortController().signal;
    const progress = vi.fn();

    await operations.install('codex', undefined, 'npm', false, manager as never, {
      signal,
      progress,
    });

    expect(runRuntimeLiveJob).toHaveBeenCalledWith(
      hostDependenciesContract.runInstallCommand,
      runInstallCommand,
      { id: 'codex', method: 'npm', elevate: false },
      progress,
      { signal }
    );
  });
});

function createOperations() {
  return createAgentOperations({
    ensureAgentDependenciesProbed: vi.fn(),
    getDependencyManager: vi.fn(),
    providerOverrideSettings: {} as never,
  });
}

describe('executable overrides', () => {
  it('probes through the supplied host client without persisting', async () => {
    const resolved = {
      id: 'claude',
      command: 'wrapper',
      path: '/remote/bin/wrapper',
      realpath: '/remote/bin/wrapper',
      source: { kind: 'cli', command: 'wrapper' },
    };
    const resolve = vi.fn(async () => ok(resolved));
    const mutate = vi.fn();
    const operations = createOperations();
    expect(
      await operations.resolveInstallation(
        'claude',
        { kind: 'cli', command: 'wrapper' },
        'remote',
        {
          resolver: { resolve },
          snapshot: { mutate },
        } as never
      )
    ).toEqual(ok(resolved));
    expect(resolve).toHaveBeenCalledWith({
      id: 'claude',
      selection: { kind: 'cli', command: 'wrapper' },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('preserves command names and propagates save errors', async () => {
    const failure = err({ type: 'io', message: 'disk full' });
    const mutate = vi.fn(async () => failure);
    expect(
      await createOperations().setUsedInstallation(
        'claude',
        undefined,
        { kind: 'cli', command: 'wrapper' },
        { snapshot: { mutate } } as never
      )
    ).toEqual(failure);
    expect(mutate).toHaveBeenCalledWith('setSelection', {
      key: undefined,
      input: { id: 'claude', selection: { kind: 'cli', command: 'wrapper' } },
    });
  });
});

describe('status reads and probing', () => {
  const FIVE_MINUTES = 5 * 60_000;

  function setup(probe = vi.fn(async () => {})) {
    const snapshot = vi.fn(async () => ({
      data: { hostId: 'local', generation: 1, hostElevation: null, dependencies: {} },
    }));
    const manager = { snapshot: { state: () => ({ snapshot }) } } as never;
    const operations = createAgentOperations({
      ensureAgentDependenciesProbed: probe,
      getDependencyManager: vi.fn(),
      providerOverrideSettings: {} as never,
    });
    return { manager, operations, probe, snapshot };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes for the first read, then answers later reads from the snapshot', async () => {
    const { manager, operations, probe, snapshot } = setup();

    await operations.listAgentInstallationStatus(undefined, manager);
    await operations.listAgentInstallationStatus(undefined, manager);
    await operations.listAgentInstallationStatus(undefined, manager);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('makes a read made during the first probe wait, without probing again', async () => {
    let finish = () => {};
    const probe = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { manager, operations, snapshot } = setup(probe);

    const first = operations.listAgentInstallationStatus(undefined, manager);
    const second = operations.listAgentInstallationStatus(undefined, manager);
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();

    finish();
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('refreshes in the background once stale, without making the read wait', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => {});
    const { manager, operations } = setup(probe);
    await operations.listAgentInstallationStatus(undefined, manager);

    vi.setSystemTime(Date.now() + FIVE_MINUTES - 1);
    await operations.listAgentInstallationStatus(undefined, manager);
    expect(probe).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    probe.mockImplementationOnce(() => new Promise<void>(() => {}));
    await operations.listAgentInstallationStatus(undefined, manager);
    expect(probe).toHaveBeenCalledTimes(2);

    // That probe never finishes, and it is not started over by the reads behind it.
    await operations.listAgentInstallationStatus(undefined, manager);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the snapshot when a background refresh fails', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => {});
    const { manager, operations, snapshot } = setup(probe);
    await operations.listAgentInstallationStatus(undefined, manager);

    vi.setSystemTime(Date.now() + FIVE_MINUTES);
    probe.mockRejectedValueOnce(new Error('probe failed'));
    await operations.listAgentInstallationStatus(undefined, manager);
    await vi.advanceTimersByTimeAsync(0);
    await operations.listAgentInstallationStatus(undefined, manager);

    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('tries again on the next read when the first probe failed', async () => {
    const probe = vi.fn(async () => {});
    probe.mockRejectedValueOnce(new Error('probe failed'));
    const { manager, operations } = setup(probe);

    await expect(operations.listAgentInstallationStatus(undefined, manager)).rejects.toThrow(
      'probe failed'
    );
    await operations.listAgentInstallationStatus(undefined, manager);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('always probes on an explicit refresh', async () => {
    const { manager, operations, probe } = setup();

    await operations.listAgentInstallationStatus(undefined, manager);
    await operations.probeAll(undefined, manager);
    await operations.probeAll(undefined, manager);

    expect(probe).toHaveBeenCalledTimes(3);
  });
});
