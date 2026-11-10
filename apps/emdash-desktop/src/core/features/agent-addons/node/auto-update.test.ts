import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import type { InstalledAddon } from '@emdash/core/runtimes/agent-config/api';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AddonDefinition } from './addon-definition';
import { updateInstalledAddons } from './auto-update';

const addon: AddonDefinition = {
  id: 'vibe',
  name: 'Vibe',
  summary: 's',
  description: 'd',
  version: 2,
  targets: [{ providerId: 'claude', files: [{ path: 'skills/vibe/SKILL.md', content: 'v2' }] }],
};

function installed(version: number, providerId = 'claude'): InstalledAddon {
  return {
    id: 'vibe',
    version,
    providerId,
    root: '/home/me/.claude',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
  };
}

function fixture(
  lists: InstalledAddon[][],
  installAddon: Mock<() => Promise<unknown>> = vi.fn(async () => ok({ addons: [] }))
) {
  let reads = 0;
  const snapshot = vi.fn(async () => ({ data: lists[Math.min(reads++, lists.length - 1)] }));
  const agentConfig = {
    addons: { state: () => ({ snapshot }) },
    installAddon,
  };
  const runtimes = { client: vi.fn(async () => ok({ agentConfig })) } as never;
  return { runtimes, installAddon, snapshot };
}

const noWait = async () => {};

describe('updateInstalledAddons', () => {
  it('updates an add-on installed at an older version without forcing over edits', async () => {
    const { runtimes, installAddon } = fixture([[installed(1)]]);
    const outcomes = await updateInstalledAddons({
      runtimes,
      host: LOCAL_HOST_REF,
      addons: [addon],
      wait: noWait,
    });
    expect(installAddon).toHaveBeenCalledWith({
      addon: { id: 'vibe', version: 2, ...addon.targets[0] },
    });
    expect(outcomes).toEqual([
      { addonId: 'vibe', providerId: 'claude', from: 1, to: 2, result: 'updated' },
    ]);
  });

  it('leaves current, missing, and other-provider installs alone', async () => {
    for (const list of [[installed(2)], [installed(1, 'codex')]]) {
      const { runtimes, installAddon } = fixture([list]);
      await updateInstalledAddons({
        runtimes,
        host: LOCAL_HOST_REF,
        addons: [addon],
        wait: noWait,
      });
      expect(installAddon).not.toHaveBeenCalled();
    }
  });

  it('retries an empty list while the runtime loads its receipts, then gives up', async () => {
    const late = fixture([[], [installed(1)]]);
    await updateInstalledAddons({
      runtimes: late.runtimes,
      host: LOCAL_HOST_REF,
      addons: [addon],
      emptyRetryDelaysMs: [10, 10],
      wait: noWait,
    });
    expect(late.snapshot).toHaveBeenCalledTimes(2);
    expect(late.installAddon).toHaveBeenCalledTimes(1);

    const none = fixture([[]]);
    await updateInstalledAddons({
      runtimes: none.runtimes,
      host: LOCAL_HOST_REF,
      addons: [addon],
      emptyRetryDelaysMs: [10, 10],
      wait: noWait,
    });
    expect(none.snapshot).toHaveBeenCalledTimes(3);
    expect(none.installAddon).not.toHaveBeenCalled();
  });

  it('reports edited files as a conflict', async () => {
    const conflict = err({ type: 'conflict' as const, paths: ['skills/vibe/SKILL.md'] });
    const { runtimes } = fixture(
      [[installed(1)]],
      vi.fn(async () => conflict)
    );
    await expect(
      updateInstalledAddons({ runtimes, host: LOCAL_HOST_REF, addons: [addon], wait: noWait })
    ).resolves.toEqual([
      {
        addonId: 'vibe',
        providerId: 'claude',
        from: 1,
        to: 2,
        result: 'conflict',
        detail: 'skills/vibe/SKILL.md',
      },
    ]);
  });

  it('does nothing when the host runtime is unavailable', async () => {
    const runtimes = {
      client: async () => err({ type: 'runtime-unavailable', message: 'down' }),
    } as never;
    await expect(
      updateInstalledAddons({ runtimes, host: LOCAL_HOST_REF, addons: [addon], wait: noWait })
    ).resolves.toEqual([]);
  });
});
