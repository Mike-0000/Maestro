import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListeningSocket, ProcessTableRow } from './listening-ports';
import {
  createProcessTreePortDetector,
  type ProcessTreeRoot,
  type ProcessTreeServer,
} from './process-tree-port-detector';

/** Agent session root 100 → 101 → 102; 102 serves the app on 4100. 999 is unrelated. */
const PROCESSES: ProcessTableRow[] = [
  { pid: 1, ppid: 0 },
  { pid: 100, ppid: 1 },
  { pid: 101, ppid: 100 },
  { pid: 102, ppid: 101 },
  { pid: 999, ppid: 1 },
];
const AGENT_SERVER: ListeningSocket = { pid: 102, address: '0.0.0.0', port: 4100 };
const UNRELATED_SERVER: ListeningSocket = { pid: 999, address: '127.0.0.1', port: 5432 };

function setup(
  options: {
    roots?: ProcessTreeRoot[];
    listeners?: ListeningSocket[];
    httpPorts?: number[];
  } = {}
) {
  const state = {
    roots: options.roots ?? [{ id: 'conversation-1', pid: 100 }],
    listeners: options.listeners ?? [AGENT_SERVER, UNRELATED_SERVER],
    processes: PROCESSES,
  };
  const httpPorts = new Set(options.httpPorts ?? [4100, 5432]);
  const snapshotter = {
    listListeners: vi.fn(async () => state.listeners),
    listProcesses: vi.fn(async () => state.processes),
  };
  const httpProbe = vi.fn(async (_host: string, port: number) =>
    httpPorts.has(port) ? ('http:' as const) : null
  );
  const servers = new Map<string, ProcessTreeServer & { rootId: string }>();
  const detected = vi.fn((rootId: string, server: ProcessTreeServer) => {
    servers.set(`${rootId}:${server.port}`, { ...server, rootId });
  });
  const closed = vi.fn((rootId: string, server: ProcessTreeServer) => {
    servers.delete(`${rootId}:${server.port}`);
  });
  const detector = createProcessTreePortDetector({
    roots: () => state.roots,
    onDetected: detected,
    onClosed: closed,
    snapshotter,
    httpProbe,
    intervalMs: 1_000,
  });
  return { state, snapshotter, httpProbe, servers, detected, closed, detector };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createProcessTreePortDetector', () => {
  it("reports a server listening in the agent session's process tree", async () => {
    const { detector, servers, httpProbe } = setup();

    await detector.poll();

    expect([...servers.values()]).toEqual([
      {
        rootId: 'conversation-1',
        protocol: 'http:',
        host: 'localhost',
        port: 4100,
        urlPath: '/',
        pid: 102,
      },
    ]);
    expect(httpProbe).toHaveBeenCalledWith('127.0.0.1', 4100);
    detector.dispose();
  });

  it('never reports or probes a listener owned by an unrelated process', async () => {
    const { detector, detected, httpProbe } = setup();

    await detector.poll();

    expect(detected).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ port: 5432 })
    );
    expect(httpProbe).not.toHaveBeenCalledWith(expect.anything(), 5432);
    detector.dispose();
  });

  it('removes the server when its listener goes away', async () => {
    const { detector, state, servers, closed } = setup();
    await detector.poll();
    expect(servers.has('conversation-1:4100')).toBe(true);

    state.listeners = [UNRELATED_SERVER];
    await detector.poll();

    expect(servers.size).toBe(0);
    expect(closed).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ port: 4100, pid: 102 })
    );
    detector.dispose();
  });

  it('removes the server when the agent session ends', async () => {
    const { detector, state, servers } = setup();
    await detector.poll();

    state.roots = [];
    await detector.poll();

    expect(servers.size).toBe(0);
    detector.dispose();
  });

  it('does not report a listener that never answers HTTP, and stops probing it', async () => {
    const { detector, detected, httpProbe } = setup({ httpPorts: [] });

    for (let i = 0; i < 5; i++) await detector.poll();

    expect(detected).not.toHaveBeenCalled();
    expect(httpProbe).toHaveBeenCalledTimes(3);
    detector.dispose();
  });

  it('reads the process table only when a new listening process appears', async () => {
    const { detector, snapshotter, state } = setup();

    await detector.poll();
    await detector.poll();
    expect(snapshotter.listListeners).toHaveBeenCalledTimes(2);
    expect(snapshotter.listProcesses).toHaveBeenCalledTimes(1);

    state.processes = [...PROCESSES, { pid: 103, ppid: 101 }];
    state.listeners = [...state.listeners, { pid: 103, address: '::', port: 4200 }];
    await detector.poll();
    expect(snapshotter.listProcesses).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('polls only while there are roots, and not after dispose', async () => {
    vi.useFakeTimers();
    const { detector, snapshotter, state } = setup({ roots: [] });

    detector.wake();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshotter.listListeners).not.toHaveBeenCalled();

    state.roots = [{ id: 'conversation-1', pid: 100 }];
    detector.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotter.listListeners).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshotter.listListeners).toHaveBeenCalledTimes(2);

    detector.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshotter.listListeners).toHaveBeenCalledTimes(2);
  });

  describe('a server whose launching shell already exited', () => {
    // The agent ran `npm run dev &` (or a background shell) in its worktree: the shell between the
    // agent and the server is gone, so the server's parent pid points nowhere and the tree walk
    // cannot reach it. The server's command line still names the worktree.
    const WORKTREE = 'C:\\work\\shop-worktrees\\checkout';
    const orphanTable = (commandLine: string): ProcessTableRow[] => [
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 1, commandLine: 'claude.exe' },
      { pid: 500, ppid: 4242, commandLine: 'node.exe npm-cli.js run dev' },
      { pid: 501, ppid: 500, commandLine },
      { pid: 999, ppid: 1, commandLine: 'postgres.exe -D C:\\pgdata' },
    ];
    const ORPHAN_SERVER: ListeningSocket = { pid: 501, address: '::1', port: 4100 };

    it("reports it when its command line names the session's worktree", async () => {
      const { detector, state, servers } = setup({
        roots: [{ id: 'conversation-1', pid: 100, cwd: WORKTREE }],
        listeners: [ORPHAN_SERVER, UNRELATED_SERVER],
      });
      state.processes = orphanTable(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\work\\shop-worktrees\\checkout\\node_modules\\vite\\bin\\vite.js --port 4100'
      );

      await detector.poll();

      expect([...servers.values()]).toEqual([
        expect.objectContaining({ rootId: 'conversation-1', port: 4100, pid: 501 }),
      ]);
      detector.dispose();
    });

    it('reports it when only a live ancestor names the worktree', async () => {
      const { detector, state, servers } = setup({
        roots: [{ id: 'conversation-1', pid: 100, cwd: WORKTREE }],
        listeners: [ORPHAN_SERVER],
      });
      state.processes = orphanTable('node.exe start-server.js').map((row) =>
        row.pid === 500
          ? {
              ...row,
              commandLine:
                'node C:/work/shop-worktrees/checkout/node_modules/next/dist/bin/next dev',
            }
          : row
      );

      await detector.poll();

      expect(servers.has('conversation-1:4100')).toBe(true);
      detector.dispose();
    });

    it('does not report it for another worktree, a prefix of the path, or a broad cwd', async () => {
      for (const cwd of [
        'C:\\work\\shop-worktrees\\check',
        'C:\\work\\shop-worktrees\\billing',
        'C:\\',
        'C:\\work',
      ]) {
        const { detector, state, detected, httpProbe } = setup({
          roots: [{ id: 'conversation-1', pid: 100, cwd }],
          listeners: [ORPHAN_SERVER],
        });
        state.processes = orphanTable(
          'node.exe C:\\work\\shop-worktrees\\checkout\\node_modules\\vite\\bin\\vite.js'
        );

        await detector.poll();

        expect(detected, cwd).not.toHaveBeenCalled();
        expect(httpProbe, cwd).not.toHaveBeenCalled();
        detector.dispose();
      }
    });
  });

  it('keeps polling after a command fails', async () => {
    const { detector, snapshotter, servers } = setup();
    snapshotter.listListeners.mockRejectedValueOnce(new Error('netstat failed'));

    await expect(detector.poll()).resolves.toBeUndefined();
    await detector.poll();

    expect(servers.has('conversation-1:4100')).toBe(true);
    detector.dispose();
  });
});
