import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { Logger } from '@emdash/shared/logger';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorSettings } from '../../api/contract';
import { findInProject, type LookupSearchPort } from './project-lookup';

const logger = { warn: vi.fn() } as unknown as Logger;

function harness(overrides: Partial<ConductorSettings> = { investigations: true }) {
  const folder = { workspaceId: 'w-1', host: LOCAL_HOST_REF, path: '/work/maestro' };
  const search: LookupSearchPort = {
    searchFiles: vi.fn(async () => [
      'src/talk/talk-line.ts',
      'src/talk/talk-store.ts',
      'src/.env',
      'docs/design/talk-mode.md',
    ]),
    searchContent: vi.fn(async () => ({
      files: [
        { path: 'src/a.ts', lines: 2 },
        { path: 'src/talk/talk-line.ts', lines: 9 },
        { path: 'config/.env', lines: 1 },
      ],
      complete: true,
    })),
  };
  const options = {
    readSettings: vi.fn(async () => ({ ...DEFAULT_CONDUCTOR_SETTINGS, ...overrides })),
    identity: {
      resolve: vi.fn(async (id: string) => (id === 'w-1' ? folder : null)),
      resolveProject: vi.fn(async (id: string) => (id === 'p-1' ? folder : null)),
    },
    search,
    logger,
  };
  const progress: number[] = [];
  const run = (input: unknown) =>
    findInProject(
      input,
      { signal: new AbortController().signal, progress: ({ done }) => progress.push(done) },
      options
    );
  return { options, search, progress, run };
}

describe('findInProject', () => {
  it('returns matching paths and files by mentions, never a denied file', async () => {
    const h = harness();
    const result = await h.run({ target: { projectId: 'p-1' }, terms: ['talk line'] });
    expect(result).toEqual({
      success: true,
      data: {
        folderName: 'maestro',
        terms: [
          {
            term: 'talk line',
            paths: ['src/talk/talk-line.ts'],
            files: [
              { path: 'src/talk/talk-line.ts', lines: 9 },
              { path: 'src/a.ts', lines: 2 },
            ],
            filesTotal: 2,
            complete: true,
          },
        ],
      },
    });
    expect(h.search.searchFiles).toHaveBeenCalledWith('w-1', 'talk line', expect.any(Number));
    expect(h.progress).toEqual([1]);
  });

  it('runs on a workspace too, whatever its host', async () => {
    const h = harness();
    const result = await h.run({ target: { workspaceId: 'w-1' }, terms: ['talk', 'line'] });
    expect(result.success && result.data.terms.map((term) => term.term)).toEqual(['talk', 'line']);
  });

  it('refuses while lookups are off, and reports an unknown project or bad input', async () => {
    expect(
      await harness({ investigations: false }).run({ target: { projectId: 'p-1' }, terms: ['x1'] })
    ).toMatchObject({ success: false, error: { type: 'disabled' } });
    const h = harness();
    expect(await h.run({ target: { projectId: 'nope' }, terms: ['talk'] })).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    for (const terms of [[], ['a'], ['two\nlines'], ['a1', 'b2', 'c3', 'd4', 'e5', 'f6']]) {
      expect(await h.run({ target: { projectId: 'p-1' }, terms })).toMatchObject({
        success: false,
        error: { type: 'failed' },
      });
    }
  });

  it('treats a content search that could not run as no hits, not an error', async () => {
    const h = harness();
    vi.mocked(h.search.searchContent).mockResolvedValueOnce(null);
    const result = await h.run({ target: { projectId: 'p-1' }, terms: ['talk'] });
    expect(result).toMatchObject({
      success: true,
      data: { terms: [{ files: [], filesTotal: 0, complete: false }] },
    });
  });
});
