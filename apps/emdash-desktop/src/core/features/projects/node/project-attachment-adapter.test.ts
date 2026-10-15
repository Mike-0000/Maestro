import { ok } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateProjectProviderDependencies } from '@core/features/projects/node/create-project-provider';
import type { Project } from '@core/primitives/projects/api';
import { openProvider } from './project-attachment-adapter';

const mocks = vi.hoisted(() => ({ createProvider: vi.fn() }));

vi.mock('@core/features/projects/node/create-project-provider', () => ({
  createProvider: mocks.createProvider,
}));
vi.mock('./operations/getProjects', () => ({ getProjectById: vi.fn() }));

const project = { id: 'p1', type: 'local', path: '/repo' } as unknown as Project;
const dependencies = {} as CreateProjectProviderDependencies;

afterEach(() => {
  vi.useRealTimers();
  mocks.createProvider.mockReset();
});

describe('openProvider', () => {
  it('returns the provider when session-open finishes in time', async () => {
    const provider = { dispose: vi.fn(async () => {}) };
    mocks.createProvider.mockResolvedValue(ok(provider));
    const result = await openProvider(dependencies, project, new AbortController().signal, 1_000);
    expect(result).toEqual(ok(provider));
    expect(provider.dispose).not.toHaveBeenCalled();
  });

  it('closes a provider that opens after session-open timed out', async () => {
    vi.useFakeTimers();
    const provider = { dispose: vi.fn(async () => {}) };
    let finish!: () => void;
    mocks.createProvider.mockImplementation(
      (_deps, _project, options: { signal: AbortSignal; progress: { step: string } }) => {
        options.progress.step = 'git-inspect-path';
        return new Promise((resolve) => (finish = () => resolve(ok(provider))));
      }
    );

    const opening = openProvider(dependencies, project, new AbortController().signal, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await opening;
    expect(result.success).toBe(false);
    expect(mocks.createProvider.mock.calls[0]![2].signal.aborted).toBe(true);

    finish();
    await vi.waitFor(() => expect(provider.dispose).toHaveBeenCalledOnce());
  });
});
