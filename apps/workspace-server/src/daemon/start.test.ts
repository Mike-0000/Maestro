import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { daemonPaths } from './paths';
import { startDaemon, type SpawnDaemon } from './start';
import type { OutsideSessionLauncher } from './windows-launch';

const health = {
  status: 'ok' as const,
  version: '1.2.3',
  uptimeMs: 10,
  protocolVersion: '1.0.0',
};

describe('startDaemon', () => {
  it('does not spawn when the daemon is already healthy', async () => {
    const socketPath = await tempSocketPath();
    const spawn = vi.fn<SpawnDaemon>();

    const result = await startDaemon({
      socketPath,
      spawn,
      probe: async () => ({ success: true, data: health }),
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'already-running',
      },
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns serve and waits for health when the daemon is absent', async () => {
    const socketPath = await tempSocketPath();
    const unref = vi.fn();
    const spawn = vi.fn<SpawnDaemon>(() => ({ pid: 1234, unref }));
    let probeCount = 0;

    const result = await startDaemon({
      socketPath,
      entrypoint: '/tmp/entry.mjs',
      execPath: '/usr/bin/node',
      platform: 'linux',
      spawn,
      sleep: async () => {},
      probe: async () => {
        probeCount += 1;
        return probeCount === 1
          ? { success: false, error: { type: 'not-running' as const, message: 'missing' } }
          : { success: true, data: health };
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'started',
        pid: 1234,
      },
    });
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/tmp/entry.mjs', 'serve', '--socket', socketPath],
      expect.objectContaining({ detached: true })
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('launches daemonize outside the SSH session job on Windows', async () => {
    const socketPath = await tempSocketPath();
    const spawn = vi.fn<SpawnDaemon>();
    const launchOutsideSession = vi.fn<OutsideSessionLauncher>(async () => ({
      success: true as const,
      data: { pid: 4242 },
    }));
    let probeCount = 0;

    const result = await startDaemon({
      socketPath,
      entrypoint: 'C:/Users/Dev User/.emdash/workspace-server/versions/1.0.0/dist/index.mjs',
      execPath: 'C:/Users/Dev User/.emdash/workspace-server/versions/1.0.0/node.exe',
      platform: 'win32',
      env: { PATH: 'C:/Windows' },
      spawn,
      launchOutsideSession,
      sleep: async () => {},
      probe: async () => {
        probeCount += 1;
        return probeCount === 1
          ? { success: false, error: { type: 'not-running' as const, message: 'missing' } }
          : { success: true, data: health };
      },
    });

    expect(result).toMatchObject({ success: true, data: { status: 'started', pid: 4242 } });
    expect(result.success && result.data.warnings).toBeFalsy();
    expect(launchOutsideSession).toHaveBeenCalledWith(
      [
        'C:/Users/Dev User/.emdash/workspace-server/versions/1.0.0/node.exe',
        'C:/Users/Dev User/.emdash/workspace-server/versions/1.0.0/dist/index.mjs',
        'daemonize',
        '--socket',
        socketPath,
      ],
      expect.objectContaining({ env: { PATH: 'C:/Windows' } })
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to a direct spawn with a warning when WMI is unavailable', async () => {
    const socketPath = await tempSocketPath();
    const spawn = vi.fn<SpawnDaemon>(() => ({ pid: 77, unref: () => {} }));
    let probeCount = 0;

    const result = await startDaemon({
      socketPath,
      entrypoint: 'C:/ws/dist/index.mjs',
      execPath: 'C:/ws/node.exe',
      platform: 'win32',
      spawn,
      launchOutsideSession: async () => ({
        success: false as const,
        error: 'Win32_Process.Create returned 2 (access denied)',
      }),
      sleep: async () => {},
      probe: async () => {
        probeCount += 1;
        return probeCount === 1
          ? { success: false, error: { type: 'not-running' as const, message: 'missing' } }
          : { success: true, data: health };
      },
    });

    expect(result).toMatchObject({ success: true, data: { status: 'started', pid: 77 } });
    expect(result.success && result.data.warnings).toEqual([
      expect.stringContaining('access denied'),
    ]);
    expect(spawn).toHaveBeenCalledWith(
      'C:/ws/node.exe',
      ['C:/ws/dist/index.mjs', 'serve', '--socket', socketPath],
      expect.objectContaining({ detached: true })
    );
  });

  it('fails instead of spawning when another start holds the lock', async () => {
    const socketPath = await tempSocketPath();
    await writeFile(daemonPaths(socketPath).lockPath, 'locked\n');

    const result = await startDaemon({
      socketPath,
      timeoutMs: 1,
      retryMs: 1,
      spawn: vi.fn<SpawnDaemon>(),
      probe: async () => ({
        success: false,
        error: { type: 'not-running' as const, message: 'missing' },
      }),
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        type: 'lock',
      },
    });
  });
});

async function tempSocketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emdash-workspace-daemon-start-'));
  return join(dir, 'workspace.sock');
}
