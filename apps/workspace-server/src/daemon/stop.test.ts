import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonPaths } from './paths';
import { writePidFile } from './pid-file';
import { stopDaemon } from './stop';

const health = {
  status: 'ok' as const,
  version: '1.2.3',
  uptimeMs: 10,
  protocolVersion: '1.0.0',
};

describe('stopDaemon', () => {
  it('sends SIGTERM and waits for the daemon to stop', async () => {
    const socketPath = await tempSocketPath();
    const paths = daemonPaths(socketPath);
    await writePidFile(paths.pidPath, 1234);
    let killed = false;

    const result = await stopDaemon({
      socketPath,
      platform: 'linux',
      sleep: async () => {},
      signaler: (_pid, signal) => {
        if (signal === 'SIGTERM') killed = true;
        if (signal === 0 && killed) throw new Error('dead');
        return true;
      },
      probe: async () =>
        killed
          ? { success: false, error: { type: 'not-running' as const, message: 'stopped' } }
          : { success: true, data: health },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'stopped',
        pid: 1234,
      },
    });
    await expect(readFile(paths.pidPath, 'utf8')).rejects.toThrow();
  });

  it('terminates the whole process tree on Windows and removes the endpoint record', async () => {
    const socketPath = await tempSocketPath();
    const paths = daemonPaths(socketPath);
    await writePidFile(paths.pidPath, 4321);
    await writeFile(paths.socketPath, 'stale endpoint record\n');
    const signals: Array<string | number | undefined> = [];
    const treeKills: number[] = [];
    let killed = false;

    const result = await stopDaemon({
      socketPath,
      platform: 'win32',
      sleep: async () => {},
      terminateTree: async (pid) => {
        treeKills.push(pid);
        killed = true;
      },
      signaler: (_pid, signal) => {
        signals.push(signal);
        if (signal === 0 && killed) throw new Error('dead');
        return true;
      },
      probe: async () =>
        killed
          ? { success: false, error: { type: 'not-running' as const, message: 'stopped' } }
          : { success: true, data: health },
    });

    expect(result).toMatchObject({ success: true, data: { status: 'stopped', pid: 4321 } });
    expect(treeKills).toEqual([4321]);
    expect(signals).not.toContain('SIGTERM');
    await expect(readFile(paths.pidPath, 'utf8')).rejects.toThrow();
    await expect(readFile(paths.socketPath, 'utf8')).rejects.toThrow();
  });

  it('reports a failed Windows tree kill instead of claiming the daemon stopped', async () => {
    const socketPath = await tempSocketPath();
    await writePidFile(daemonPaths(socketPath).pidPath, 4321);

    const result = await stopDaemon({
      socketPath,
      platform: 'win32',
      terminateTree: async () => {
        throw new Error('taskkill failed for pid 4321: Access is denied.');
      },
      signaler: () => true,
    });

    expect(result).toMatchObject({
      success: false,
      error: { type: 'signal', message: expect.stringContaining('Access is denied') },
    });
  });

  it('cleans up a stale pid file', async () => {
    const socketPath = await tempSocketPath();
    const paths = daemonPaths(socketPath);
    await writePidFile(paths.pidPath, 1234);

    const result = await stopDaemon({
      socketPath,
      signaler: (_pid, signal) => {
        if (signal === 0) throw new Error('dead');
        return true;
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'not-running',
        pid: 1234,
      },
    });
    await expect(readFile(paths.pidPath, 'utf8')).rejects.toThrow();
  });
});

async function tempSocketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emdash-workspace-daemon-stop-'));
  return join(dir, 'workspace.sock');
}
