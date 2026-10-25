import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { err, ok } from '@emdash/shared';
import { peek } from '@emdash/wire/state';
import { describe, expect, it } from 'vitest';
import type { AddonInstallPayload, InstalledAddon } from '#runtimes/agent-config/api';
import { createAgentConfigAddonsModel } from '#runtimes/agent-config/node/state/live-models';
import { createLocalPluginFs } from '#services/agent-plugins/api/plugins/helpers';
import { AgentAddonsManager } from './addons';

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'emdash-addons-'));
  const root = path.join(home, '.claude');
  const model = createAgentConfigAddonsModel();
  const manager = new AgentAddonsManager(
    {
      homeFs: createLocalPluginFs(home),
      resolveConfigRoot: async (providerId) =>
        providerId === 'claude' ? ok(root) : err({ type: 'unknown-provider', providerId }),
      openFs: createLocalPluginFs,
    },
    model
  );
  await manager.initialize();
  const read = (relative: string) => readFile(path.join(root, relative), 'utf8');
  return { home, root, model, manager, read };
}

function payload(overrides: Partial<AddonInstallPayload> = {}): AddonInstallPayload {
  return {
    id: 'vibe',
    version: 1,
    providerId: 'claude',
    files: [
      { path: 'skills/vibe/SKILL.md', content: 'skill v1\n' },
      { path: 'agents/vibe-fast.md', content: 'fast v1\n' },
    ],
    instructions: { path: 'CLAUDE.md', content: '# Vibe mode\n\nUse it.\n' },
    ...overrides,
  };
}

function only(list: InstalledAddon[]): InstalledAddon {
  expect(list).toHaveLength(1);
  return list[0]!;
}

describe('AgentAddonsManager', () => {
  it('installs files and an instructions block next to the developer text', async () => {
    const { root, manager, read, model } = await setup();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Mine\n');

    const result = await manager.install(payload());

    expect(result.success).toBe(true);
    expect(await read('skills/vibe/SKILL.md')).toBe('skill v1\n');
    expect(await read('agents/vibe-fast.md')).toBe('fast v1\n');
    const claudeMd = await read('CLAUDE.md');
    expect(claudeMd.startsWith('# Mine\n\n<!-- maestro-addon:vibe:start')).toBe(true);
    expect(claudeMd).toContain('# Vibe mode\n\nUse it.\n<!-- maestro-addon:vibe:end -->');
    const installed = only(peek(model.states.list));
    expect(installed.root).toBe(root);
    expect(installed.files.map((file) => file.state)).toEqual(['intact', 'intact']);
    expect(installed.instructions).toEqual({ path: 'CLAUDE.md', state: 'intact' });
  });

  it('removes exactly what it added, including emptied folders', async () => {
    const { root, manager, read } = await setup();
    await mkdir(path.join(root, 'skills'), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Mine\n');
    await writeFile(path.join(root, 'skills', 'keep.txt'), 'other');
    await manager.install(payload());

    const result = await manager.remove('claude', 'vibe');

    expect(result.success && result.data).toEqual([]);
    expect(await read('CLAUDE.md')).toBe('# Mine\n');
    expect((await readdir(path.join(root, 'skills'))).sort()).toEqual(['keep.txt']);
    expect(await readdir(root)).not.toContain('agents');
  });

  it('deletes an instructions file it created once the block is gone', async () => {
    const { root, manager } = await setup();
    await manager.install(payload());
    await manager.remove('claude', 'vibe');
    expect(await readdir(root).catch(() => [])).not.toContain('CLAUDE.md');
  });

  it('adopts files that already hold the same content', async () => {
    const { root, manager } = await setup();
    await mkdir(path.join(root, 'skills', 'vibe'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'vibe', 'SKILL.md'), 'skill v1\r\n');
    expect((await manager.install(payload())).success).toBe(true);
  });

  it('reports files that hold something else instead of overwriting them', async () => {
    const { root, manager, read } = await setup();
    await mkdir(path.join(root, 'agents'), { recursive: true });
    await writeFile(path.join(root, 'agents', 'vibe-fast.md'), 'my own agent\n');

    const result = await manager.install(payload());

    expect(result).toEqual(err({ type: 'conflict', paths: ['agents/vibe-fast.md'] }));
    expect(await read('agents/vibe-fast.md')).toBe('my own agent\n');
    expect((await manager.install(payload(), { replace: true })).success).toBe(true);
    expect(await read('agents/vibe-fast.md')).toBe('fast v1\n');
  });

  it('updates its own unchanged files and drops files the new version no longer has', async () => {
    const { root, manager, read, model } = await setup();
    await manager.install(payload());

    const result = await manager.install(
      payload({
        version: 2,
        files: [{ path: 'skills/vibe/SKILL.md', content: 'skill v2\n' }],
        instructions: { path: 'CLAUDE.md', content: 'Use it, v2.' },
      })
    );

    expect(result.success).toBe(true);
    expect(await read('skills/vibe/SKILL.md')).toBe('skill v2\n');
    expect(await readdir(root)).not.toContain('agents');
    expect(await read('CLAUDE.md')).toContain('Use it, v2.');
    expect(await read('CLAUDE.md')).not.toContain('# Vibe mode');
    expect(only(peek(model.states.list)).version).toBe(2);
  });

  it('treats a file the developer edited as a conflict on update', async () => {
    const { root, manager, model } = await setup();
    await manager.install(payload());
    await writeFile(path.join(root, 'skills', 'vibe', 'SKILL.md'), 'my tweak\n');

    const result = await manager.install(payload({ version: 2 }));

    expect(result).toEqual(err({ type: 'conflict', paths: ['skills/vibe/SKILL.md'] }));
    expect(only(peek(model.states.list)).files[0]).toEqual({
      path: 'skills/vibe/SKILL.md',
      state: 'edited',
    });
  });

  it('rejects paths that leave the config folder', async () => {
    const { manager } = await setup();
    for (const bad of ['../outside.md', '/etc/passwd', 'C:/x.md', 'a\\b.md', 'skills/./x.md']) {
      const result = await manager.install(payload({ files: [{ path: bad, content: 'x' }] }));
      expect(result.success).toBe(false);
      expect(!result.success && result.error.type).toBe('invalid-state');
    }
  });

  it('rejects unknown providers', async () => {
    const { manager } = await setup();
    const result = await manager.install(payload({ providerId: 'nope' }));
    expect(result).toEqual(err({ type: 'unknown-provider', providerId: 'nope' }));
  });

  it('rehydrates installed add-ons from receipts', async () => {
    const { home, root, manager } = await setup();
    await manager.install(payload());
    const model = createAgentConfigAddonsModel();
    const again = new AgentAddonsManager(
      {
        homeFs: createLocalPluginFs(home),
        resolveConfigRoot: async () => ok(root),
        openFs: createLocalPluginFs,
      },
      model
    );
    await again.initialize();
    expect(only(peek(model.states.list)).id).toBe('vibe');
  });
});
