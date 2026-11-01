import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  releaseInstallTargetGate,
  reserveInstallTargetGate,
} from './coordinator/install-target-gate.mjs';
import { createLocalUpdateService } from './local-update-service';

const mocks = vi.hoisted(() => ({
  stateRoot: '',
  coordinator: {
    status: vi.fn(),
    join: vi.fn(),
    invalidate: vi.fn(),
  },
  warn: vi.fn(),
}));

vi.mock('./coordinator/coordinator.mjs', () => ({
  createCoordinator: () => mocks.coordinator,
  defaultStateRoot: () => mocks.stateRoot,
}));

vi.mock('@emdash/shared/logger', async (original) => ({
  ...(await original<object>()),
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function fakeDb(path: string) {
  const rows = [
    { path, location: 'local', id: 'task-a', name: 'Task', workspaceId: 'w', archivedAt: null },
  ];
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'leftJoin', 'innerJoin', 'where']) {
    chain[method] = () => chain;
  }
  chain.limit = async () => rows;
  return chain as never;
}

function deferred() {
  let resolve: (value?: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('recordInputSubmitted', () => {
  let service: ReturnType<typeof createLocalUpdateService>;

  async function leaseCount(): Promise<number> {
    return (await readdir(join(mocks.stateRoot, 'DispatchLeases'))).length;
  }

  beforeEach(async () => {
    mocks.stateRoot = await mkdtemp(join(tmpdir(), 'chorus-input-state-'));
    const repository = await mkdtemp(join(tmpdir(), 'chorus-input-repo-'));
    mocks.warn.mockReset();
    mocks.coordinator.status.mockReset().mockResolvedValue({ enabled: true });
    mocks.coordinator.join.mockReset().mockResolvedValue({ result: { joined: false } });
    mocks.coordinator.invalidate.mockReset().mockResolvedValue({ result: {} });
    service = createLocalUpdateService(fakeDb(repository), {} as never, {
      getActiveSessionSummary: vi.fn(),
    });
  });

  it('returns without waiting for the coordinator, which then records the work', async () => {
    const status = deferred();
    mocks.coordinator.status.mockReturnValue(status.promise);

    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    expect(delivered).toBeTypeOf('function');
    expect(mocks.coordinator.invalidate).not.toHaveBeenCalled();

    status.resolve({ enabled: true });
    await vi.waitFor(() => expect(mocks.coordinator.invalidate).toHaveBeenCalledOnce());
    delivered();
  });

  it('holds the lease until the input is delivered and the recording has finished', async () => {
    const invalidate = deferred();
    mocks.coordinator.invalidate.mockReturnValue(invalidate.promise);

    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    expect(await leaseCount()).toBe(1);

    delivered();
    await flush();
    expect(await leaseCount()).toBe(1);

    invalidate.resolve({ result: {} });
    await vi.waitFor(async () => expect(await leaseCount()).toBe(0));
  });

  it('holds the lease until delivery even when the recording finished first', async () => {
    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    await vi.waitFor(() => expect(mocks.coordinator.invalidate).toHaveBeenCalledOnce());
    await flush();
    expect(await leaseCount()).toBe(1);

    delivered();
    await vi.waitFor(async () => expect(await leaseCount()).toBe(0));
  });

  it('refuses the input when an install has new work paused', async () => {
    await reserveInstallTargetGate({
      stateRoot: mocks.stateRoot,
      ownerId: 'installer',
      repositoryPath: '/repo',
      projectId: 'project-a',
      candidateId: 'candidate',
      commit: 'a'.repeat(40),
    });

    await expect(service.recordInputSubmitted('project-a', 'task-a')).rejects.toThrow(
      'new sessions are paused'
    );
    expect(await leaseCount()).toBe(0);

    await releaseInstallTargetGate({
      stateRoot: mocks.stateRoot,
      ownerId: 'installer',
      repositoryPath: '/repo',
      candidateId: 'candidate',
    });
  });

  it('logs a recording that fails and still lets the lease go', async () => {
    mocks.coordinator.invalidate.mockRejectedValue(new Error('update applying'));

    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    delivered();

    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        'local updates: recording submitted input failed',
        expect.objectContaining({ taskId: 'task-a' })
      )
    );
    await vi.waitFor(async () => expect(await leaseCount()).toBe(0));
  });

  it('retries when the state database is busy', async () => {
    mocks.coordinator.status
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue({ enabled: true });

    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    delivered();

    await vi.waitFor(() => expect(mocks.coordinator.invalidate).toHaveBeenCalledOnce());
    expect(mocks.coordinator.status).toHaveBeenCalledTimes(2);
  });

  it('shares a running recording, and runs one more pass for Enter pressed during it', async () => {
    const invalidate = deferred();
    mocks.coordinator.invalidate.mockReturnValueOnce(invalidate.promise);

    const first = await service.recordInputSubmitted('project-a', 'task-a');
    await vi.waitFor(() => expect(mocks.coordinator.invalidate).toHaveBeenCalledOnce());
    const second = await service.recordInputSubmitted('project-a', 'task-a');
    const third = await service.recordInputSubmitted('project-a', 'task-a');
    expect(mocks.coordinator.invalidate).toHaveBeenCalledOnce();

    invalidate.resolve({ result: {} });
    first();
    second();
    third();

    await vi.waitFor(async () => expect(await leaseCount()).toBe(0));
    expect(mocks.coordinator.invalidate).toHaveBeenCalledTimes(2);
  });

  it('does nothing further for a project without the coordinator', async () => {
    mocks.coordinator.status.mockResolvedValue({ enabled: false });

    const delivered = await service.recordInputSubmitted('project-a', 'task-a');
    delivered();
    await vi.waitFor(async () => expect(await leaseCount()).toBe(0));

    expect(mocks.coordinator.join).not.toHaveBeenCalled();
    expect(mocks.coordinator.invalidate).not.toHaveBeenCalled();
  });
});
