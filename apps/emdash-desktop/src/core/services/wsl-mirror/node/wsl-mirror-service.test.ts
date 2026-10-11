import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIRROR_AGENT_SOURCE } from './mirror-agent-source';
import { createWorkerAgent } from './mirror-agents';
import { WslMirrorService } from './wsl-mirror-service';

/**
 * The service with both agents on this computer: `linuxPath` is just another local folder, so
 * what is tested is how mirrors are remembered, paused and removed.
 */

const services: WslMirrorService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { directory: string; a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), 'maestro-mirror-service-'));
  roots.push(root);
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  return { directory: join(root, 'data'), a, b };
}

function service(directory: string): WslMirrorService {
  const created = new WslMirrorService({
    directory,
    log: { info: () => {}, warn: () => {} },
    createAgents: async (link, preserve) => ({
      a: {
        agent: createWorkerAgent(MIRROR_AGENT_SOURCE),
        init: { root: link.windowsPath, preserve },
      },
      b: {
        agent: createWorkerAgent(MIRROR_AGENT_SOURCE),
        init: { root: link.linuxPath, peerRoot: link.windowsPath, preserve },
      },
    }),
  });
  services.push(created);
  return created;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('WslMirrorService', { timeout: 60_000 }, () => {
  it('creates a mirror once, runs it, and remembers it across restarts', async () => {
    const { directory, a, b } = setup();
    writeFileSync(join(a, 'one.txt'), 'one');
    const first = service(directory);
    const input = { name: 'demo', windowsPath: a, distro: 'Ubuntu', linuxPath: b };

    const created = await first.create(input);
    expect((await first.create(input)).id).toBe(created.id);
    await expect(first.create({ ...input, linuxPath: `${b}-other` })).rejects.toThrow(
      /already mirrored/
    );

    const synced = await first.waitUntilSynced(created.id, 30_000);
    expect(synced.status.phase).toBe('synced');
    expect(synced.seeded).toBe(true);
    expect(readFileSync(join(b, 'one.txt'), 'utf8')).toBe('one');
    await first.dispose();

    // While the app is closed: a new file in the copy, and a deletion on Windows.
    writeFileSync(join(b, 'two.txt'), 'two');
    rmSync(join(a, 'one.txt'));

    const second = service(directory);
    const [remembered] = await second.list();
    expect(remembered?.id).toBe(created.id);
    await second.waitUntilSynced(created.id, 30_000);
    expect(readFileSync(join(a, 'two.txt'), 'utf8')).toBe('two');
    expect(existsSync(join(b, 'one.txt'))).toBe(false);
  });

  it('stops carrying changes while paused, and catches up when resumed', async () => {
    const { directory, a, b } = setup();
    writeFileSync(join(a, 'file.txt'), 'v1');
    const mirrors = service(directory);
    const { id } = await mirrors.create({
      name: 'demo',
      windowsPath: a,
      distro: 'Ubuntu',
      linuxPath: b,
    });
    await mirrors.waitUntilSynced(id, 30_000);

    expect((await mirrors.setPaused(id, true)).status.phase).toBe('paused');
    writeFileSync(join(a, 'file.txt'), 'v2, written while paused');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(readFileSync(join(b, 'file.txt'), 'utf8')).toBe('v1');

    await mirrors.setPaused(id, false);
    await until(
      () => readFileSync(join(b, 'file.txt'), 'utf8') === 'v2, written while paused',
      'the change made while paused to arrive'
    );
  });

  it('leaves both folders alone when a mirror is removed', async () => {
    const { directory, a, b } = setup();
    writeFileSync(join(a, 'file.txt'), 'kept');
    const mirrors = service(directory);
    const { id } = await mirrors.create({
      name: 'demo',
      windowsPath: a,
      distro: 'Ubuntu',
      linuxPath: b,
    });
    await mirrors.waitUntilSynced(id, 30_000);

    await mirrors.remove(id);
    expect(await mirrors.list()).toEqual([]);
    writeFileSync(join(a, 'later.txt'), 'not mirrored any more');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(join(b, 'later.txt'))).toBe(false);
    expect(readFileSync(join(b, 'file.txt'), 'utf8')).toBe('kept');
    expect(readFileSync(join(a, 'file.txt'), 'utf8')).toBe('kept');
  });
});
