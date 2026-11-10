import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStubLogger, deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPluginHost, ITrustBehavior } from '#services/agent-plugins/api/plugins';
import { TuiWorkspaceTrust } from './workspace-trust';

describe('TuiWorkspaceTrust', () => {
  it('does nothing when the provider has no trust behavior', async () => {
    const { trust, agentHost, logs } = createTrust();

    await trust.ensureTrusted({ providerId: 'test', workspacePath: '/workspace' });

    expect(agentHost.get).toHaveBeenCalledWith('test');
    expect(logs).toEqual([]);
  });

  it('refuses non-absolute workspace paths', async () => {
    const trustWorkspace = vi.fn(async () => {});
    const { trust, logs } = createTrust({ trustWorkspace });

    await trust.ensureTrusted({ providerId: 'test', workspacePath: 'relative/workspace' });

    expect(trustWorkspace).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      level: 'warn',
      message: 'TuiWorkspaceTrust: refusing to trust non-absolute workspace path',
      fields: {
        providerId: 'test',
        workspacePath: 'relative/workspace',
      },
    });
  });

  it('logs and swallows trust behavior failures', async () => {
    const { trust, logs } = createTrust({
      trustWorkspace: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(
      trust.ensureTrusted({ providerId: 'test', workspacePath: '/workspace/../worktree' })
    ).resolves.toBeUndefined();

    expect(logs).toContainEqual({
      level: 'warn',
      message: 'TuiWorkspaceTrust: failed to trust workspace',
      fields: {
        providerId: 'test',
        workspacePath: path.normalize('/workspace/../worktree'),
        error: 'Error: boom',
      },
    });
  });

  describe('where the trust record is written', () => {
    const behavior = (): ITrustBehavior => ({
      trustWorkspace: async (fs, context) => fs.write('trust.json', context.workspacePath),
      resolveConfigRoot: ({ env, homeDir }) => env.TEST_CONFIG_DIR ?? homeDir,
    });
    const withDirs = async (run: (home: string, account: string) => Promise<void>) => {
      const root = await mkdtemp(path.join(tmpdir(), 'workspace-trust-'));
      try {
        await run(path.join(root, 'home'), path.join(root, 'account'));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    const written = (dir: string) =>
      readFile(path.join(dir, 'trust.json'), 'utf8').catch(() => null);

    it("follows the session's configuration directory", async () => {
      await withDirs(async (homeDir, account) => {
        const { trust } = createTrust(behavior(), { homeDir });

        await trust.ensureTrusted({
          providerId: 'test',
          workspacePath: '/workspace',
          env: { TEST_CONFIG_DIR: account },
        });

        expect(await written(account)).toBe('/workspace');
        expect(await written(homeDir)).toBeNull();
      });
    });

    it('is the home directory for a session without one', async () => {
      await withDirs(async (homeDir, account) => {
        const { trust } = createTrust(behavior(), { homeDir });

        await trust.ensureTrusted({ providerId: 'test', workspacePath: '/workspace' });

        expect(await written(homeDir)).toBe('/workspace');
        expect(await written(account)).toBeNull();
      });
    });

    it('is the home directory for a provider that does not resolve one', async () => {
      await withDirs(async (homeDir, account) => {
        const { trust } = createTrust(
          { trustWorkspace: async (fs, context) => fs.write('trust.json', context.workspacePath) },
          { homeDir }
        );

        await trust.ensureTrusted({
          providerId: 'test',
          workspacePath: '/workspace',
          env: { TEST_CONFIG_DIR: account },
        });

        expect(await written(homeDir)).toBe('/workspace');
      });
    });
  });

  it('serializes writes to the shared home configuration', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const workspacePaths: string[] = [];
    const trustWorkspace = vi.fn(async (_fs, context) => {
      workspacePaths.push(context.workspacePath);
      if (workspacePaths.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    const { trust } = createTrust({ trustWorkspace });

    const first = trust.ensureTrusted({ providerId: 'test', workspacePath: '/workspace/one' });
    await firstStarted.promise;
    const second = trust.ensureTrusted({ providerId: 'test', workspacePath: '/workspace/two' });

    await Promise.resolve();
    expect(workspacePaths).toEqual(['/workspace/one']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(workspacePaths).toEqual(['/workspace/one', '/workspace/two']);
  });
});

function createTrust(
  behavior?: ITrustBehavior,
  host: { homeDir?: string; env?: Record<string, string> } = {}
) {
  const { logger, calls: logs } = createStubLogger();
  const homeDir = host.homeDir ?? '/home/test-user';
  const agentHost = {
    homeDir,
    configRootContext: async () => ({ env: host.env ?? {}, homeDir, platform: 'linux' }),
    get: vi.fn(() => ({ behavior: behavior ? { trust: behavior } : {} })),
  } as unknown as AgentPluginHost;
  return {
    agentHost,
    logs,
    trust: new TuiWorkspaceTrust({ agentHost, logger }),
  };
}
