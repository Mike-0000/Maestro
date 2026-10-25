import { hostRef } from '@emdash/core/primitives/host/api';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AddonDefinition } from './addon-definition';
import { ADDONS } from './addons';
import { createAgentAddonsWireController } from './wire-controller';

const remoteHost = hostRef('remote', 'ssh-3');

const twoTargets: AddonDefinition = {
  id: 'pair',
  name: 'Pair',
  summary: 's',
  description: 'd',
  version: 3,
  targets: [
    { providerId: 'claude', files: [{ path: 'skills/pair/SKILL.md', content: 'a' }] },
    {
      providerId: 'codex',
      files: [{ path: 'skills/pair/SKILL.md', content: 'b' }],
      instructions: { path: 'AGENTS.md', content: 'c' },
    },
  ],
};

describe('createAgentAddonsWireController', () => {
  it('installs every target of an add-on on the selected host', async () => {
    const installAddon = vi.fn(async () => ok({ addons: [] }));
    const client = vi.fn(async () => ok({ agentConfig: { installAddon } }));
    const controller = createAgentAddonsWireController({
      runtimes: { client } as never,
      addons: [twoTargets],
    });

    await expect(
      controller.call('install', { host: remoteHost, addonId: 'pair', replace: true })
    ).resolves.toEqual(ok({ addons: [] }));

    expect(client).toHaveBeenCalledWith(remoteHost);
    expect(installAddon).toHaveBeenNthCalledWith(
      1,
      {
        addon: { id: 'pair', version: 3, ...twoTargets.targets[0] },
        replace: true,
      },
      {}
    );
    expect(installAddon).toHaveBeenNthCalledWith(
      2,
      {
        addon: { id: 'pair', version: 3, ...twoTargets.targets[1] },
        replace: true,
      },
      {}
    );
  });

  it('stops at the first failing target', async () => {
    const conflict = err({ type: 'conflict' as const, paths: ['skills/pair/SKILL.md'] });
    const installAddon = vi.fn(async () => conflict);
    const controller = createAgentAddonsWireController({
      runtimes: { client: async () => ok({ agentConfig: { installAddon } }) } as never,
      addons: [twoTargets],
    });

    await expect(
      controller.call('install', { host: remoteHost, addonId: 'pair' })
    ).resolves.toEqual(conflict);
    expect(installAddon).toHaveBeenCalledTimes(1);
  });

  it('removes targets and skips ones that were never installed', async () => {
    const removeAddon = vi
      .fn()
      .mockResolvedValueOnce(ok({ addons: [] }))
      .mockResolvedValueOnce(err({ type: 'invalid-state', message: 'not installed' }));
    const controller = createAgentAddonsWireController({
      runtimes: { client: async () => ok({ agentConfig: { removeAddon } }) } as never,
      addons: [twoTargets],
    });

    await expect(controller.call('remove', { host: remoteHost, addonId: 'pair' })).resolves.toEqual(
      ok({ addons: [] })
    );
    expect(removeAddon).toHaveBeenCalledWith({ id: 'pair', providerId: 'codex' }, {});
  });

  it('rejects add-ons this version does not ship', async () => {
    const controller = createAgentAddonsWireController({
      runtimes: { client: vi.fn() } as never,
      addons: [],
    });
    await expect(
      controller.call('install', { host: remoteHost, addonId: 'nope' })
    ).resolves.toEqual(err({ type: 'unknown-addon', addonId: 'nope' }));
  });

  it('lists the shipped add-ons with what each one writes', async () => {
    const controller = createAgentAddonsWireController({ runtimes: { client: vi.fn() } as never });
    const catalog = (await controller.call('catalog', undefined)) as {
      id: string;
      targets: { providerName: string; files: string[]; instructions?: { path: string } }[];
    }[];
    const vibe = catalog.find((entry) => entry.id === 'vibe');
    expect(vibe?.targets[0]).toMatchObject({
      providerName: 'Claude Code',
      files: ['skills/vibe/SKILL.md', 'agents/vibe-fast.md', 'agents/vibe-good.md'],
      instructions: { path: 'CLAUDE.md' },
    });
  });

  it('ships add-ons whose ids and paths the installer accepts', () => {
    for (const addon of ADDONS) {
      expect(addon.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      for (const target of addon.targets) {
        for (const file of target.files) {
          expect(file.path).not.toMatch(/(^\/|\\|:|(^|\/)\.\.?(\/|$))/);
          expect(file.content.trim()).not.toBe('');
        }
      }
    }
  });
});
