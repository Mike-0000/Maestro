import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectHostAccess,
  ProjectHostAccessState,
} from '@core/features/projects/api/browser/stores/project-context';
import { TerminalManagerStore } from '@core/features/terminals/api/browser/task-terminal/terminal-manager';

const createTerminal = vi.hoisted(() => vi.fn());
const listTerminals = vi.hoisted(() => vi.fn());
const hydrateTerminal = vi.hoisted(() => vi.fn());
const renameTerminal = vi.hoisted(() => vi.fn());
const deleteTerminal = vi.hoisted(() => vi.fn());
const frontendConnect = vi.hoisted(() => vi.fn());
const frontendDispose = vi.hoisted(() => vi.fn());
const getAppSettingValueSnapshot = vi.hoisted(() => vi.fn());

vi.mock('@core/features/editor/api/browser/open-file-in-file-editor', () => ({
  makeFileLinkHandlers: () => ({}),
}));

vi.mock('@core/features/settings/api/browser/app-settings-client', () => ({
  getAppSettingValueSnapshot,
}));

vi.mock('@core/features/terminals/api/browser/client', () => ({
  getTerminalsClient: async () => ({
    create: createTerminal,
    delete: deleteTerminal,
    list: listTerminals,
    hydrate: hydrateTerminal,
    rename: renameTerminal,
  }),
}));

vi.mock('@core/features/terminals/api/browser/pty/pty', () => ({
  FrontendPty: class {
    constructor(readonly sessionId: string) {}

    connect = frontendConnect;
    dispose = frontendDispose;
  },
}));

vi.mock('@core/features/conversations/browser/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@core/features/conversations/browser/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

describe('TerminalManagerStore session hydration', () => {
  beforeEach(() => {
    createTerminal.mockReset();
    listTerminals.mockReset();
    hydrateTerminal.mockReset();
    renameTerminal.mockReset();
    deleteTerminal.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();
    getAppSettingValueSnapshot.mockReset();

    createTerminal.mockImplementation(async (input) => ({
      success: true,
      data: {
        terminal: { ...input, shellId: input.shell ?? 'system' },
        key: { workspaceId: 'workspace-1', terminalId: input.id },
      },
    }));
    listTerminals.mockResolvedValue({ success: true, data: [] });
    hydrateTerminal.mockResolvedValue({
      success: true,
      data: {
        key: { workspaceId: 'workspace-1', terminalId: 'terminal-1' },
      },
    });
    renameTerminal.mockResolvedValue({ success: true, data: undefined });
    deleteTerminal.mockResolvedValue({ success: true, data: undefined });
    frontendConnect.mockResolvedValue(undefined);
    getAppSettingValueSnapshot.mockReturnValue(undefined);
  });

  it('creates terminal sessions from records without hydrating until the session connects', async () => {
    listTerminals.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'terminal-1',
          projectId: 'project-1',
          taskId: 'task-1',
          shellId: 'system',
          name: 'Terminal 1',
        },
      ],
    });
    const store = new TerminalManagerStore('project-1', 'task-1');

    store.list.setValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        taskId: 'task-1',
        shellId: 'system',
        name: 'Terminal 1',
      },
    ]);

    expect(hydrateTerminal).not.toHaveBeenCalled();

    const session = store.sessions.get('terminal-1');
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(hydrateTerminal).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      terminalId: 'terminal-1',
    });
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    await session?.connect();

    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('uses the cached default shell for optimistic terminals when no shell is specified', async () => {
    getAppSettingValueSnapshot.mockReturnValue({ defaultShell: 'fish' });
    createTerminal.mockResolvedValue({
      success: true,
      data: {
        terminal: {
          id: 'terminal-1',
          projectId: 'project-1',
          taskId: 'task-1',
          shellId: 'fish',
          name: 'Terminal 1',
        },
        key: { workspaceId: 'workspace-1', terminalId: 'terminal-1' },
      },
    });
    const store = new TerminalManagerStore('project-1', 'task-1');

    const promise = store.createTerminal({
      id: 'terminal-1',
      projectId: 'project-1',
      taskId: 'task-1',
      name: 'Terminal 1',
    });

    expect(store.terminals.get('terminal-1')?.data.shellId).toBe('fish');
    await promise;
    store.dispose();
  });

  it('connects a new terminal only after the main process has created it', async () => {
    // The main process writes the terminal's row while `create` is in flight; hydrating before
    // then answers "Terminal not found". The pane connects as soon as the optimistic session
    // shows, so without waiting it raced the create and the terminal stayed blank.
    let rowWritten = false;
    let finishCreate: () => void = () => {};
    createTerminal.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finishCreate = () => {
            rowWritten = true;
            resolve({
              success: true,
              data: {
                terminal: { ...input, shellId: 'system' },
                key: { workspaceId: 'workspace-1', terminalId: input.id },
              },
            });
          };
        })
    );
    hydrateTerminal.mockImplementation(async (input) =>
      rowWritten
        ? {
            success: true,
            data: { key: { workspaceId: 'workspace-1', terminalId: input.terminalId } },
          }
        : { success: false, error: { type: 'not_found', message: 'Terminal not found' } }
    );
    // The list load stays in flight, so it cannot replace the optimistic record mid-test.
    listTerminals.mockReturnValue(new Promise(() => {}));
    const store = new TerminalManagerStore('project-1', 'task-1');

    const created = store.createTerminal({
      id: 'terminal-new',
      projectId: 'project-1',
      taskId: 'task-1',
      name: 'Terminal 1',
    });
    const session = store.sessions.get('terminal-new');
    expect(session).toBeDefined();
    const connected = session!.connect();

    // Let the connect run as far as it can before the create returns.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hydrateTerminal).not.toHaveBeenCalled();
    expect(session!.status).toBe('connecting');

    finishCreate();
    await created;
    await connected;

    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(frontendConnect).toHaveBeenCalledTimes(1);
    expect(session!.status).toBe('ready');
    store.dispose();
  });

  it('stops a waiting connect when creating the terminal fails', async () => {
    let failCreate: () => void = () => {};
    createTerminal.mockImplementation(
      () =>
        new Promise((resolve) => {
          failCreate = () =>
            resolve({ success: false, error: { type: 'failed', message: 'No shell' } });
        })
    );
    // The list load stays in flight, so it cannot replace the optimistic record mid-test.
    listTerminals.mockReturnValue(new Promise(() => {}));
    const store = new TerminalManagerStore('project-1', 'task-1');

    const created = store.createTerminal({
      id: 'terminal-broken',
      projectId: 'project-1',
      taskId: 'task-1',
      name: 'Terminal 1',
    });
    const session = store.sessions.get('terminal-broken');
    const connected = session!.connect();

    await new Promise((resolve) => setTimeout(resolve, 10));
    failCreate();
    await expect(created).rejects.toThrow('No shell');
    await connected;

    expect(store.sessions.has('terminal-broken')).toBe(false);
    expect(hydrateTerminal).not.toHaveBeenCalled();
    expect(frontendConnect).not.toHaveBeenCalled();
    store.dispose();
  });

  it('stops waiting for a create that never settles and retries once it succeeds', async () => {
    vi.useFakeTimers();
    try {
      let rowWritten = false;
      let finishCreate: () => void = () => {};
      createTerminal.mockImplementation(
        (input) =>
          new Promise((resolve) => {
            finishCreate = () => {
              rowWritten = true;
              resolve({
                success: true,
                data: {
                  terminal: { ...input, shellId: 'system' },
                  key: { workspaceId: 'workspace-1', terminalId: input.id },
                },
              });
            };
          })
      );
      hydrateTerminal.mockImplementation(async (input) =>
        rowWritten
          ? {
              success: true,
              data: { key: { workspaceId: 'workspace-1', terminalId: input.terminalId } },
            }
          : { success: false, error: { type: 'not_found', message: 'Terminal not found' } }
      );
      listTerminals.mockReturnValue(new Promise(() => {}));
      const store = new TerminalManagerStore('project-1', 'task-1');

      const created = store.createTerminal({
        id: 'terminal-slow',
        projectId: 'project-1',
        taskId: 'task-1',
        name: 'Terminal 1',
      });
      const session = store.sessions.get('terminal-slow')!;
      const connected = session.connect();
      const connectResult = connected.then(
        () => 'resolved',
        () => 'rejected'
      );

      // The wait is bounded: the connect hydrates, fails as before, and does not hang.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await connectResult).toBe('rejected');
      expect(hydrateTerminal).toHaveBeenCalledTimes(1);
      expect(session.status).toBe('disconnected');

      // The late create still succeeds and reconnects the session the pane asked for.
      finishCreate();
      await created;
      await vi.advanceTimersByTimeAsync(0);
      expect(frontendConnect).toHaveBeenCalledTimes(1);
      expect(session.status).toBe('ready');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a waiting connect when the store is disposed', async () => {
    createTerminal.mockReturnValue(new Promise(() => {}));
    listTerminals.mockReturnValue(new Promise(() => {}));
    const store = new TerminalManagerStore('project-1', 'task-1');

    void store
      .createTerminal({
        id: 'terminal-gone',
        projectId: 'project-1',
        taskId: 'task-1',
        name: 'Terminal 1',
      })
      .catch(() => {});
    const session = store.sessions.get('terminal-gone')!;
    const connected = session.connect();

    await new Promise((resolve) => setTimeout(resolve, 10));
    store.dispose();
    await connected;

    expect(hydrateTerminal).not.toHaveBeenCalled();
    expect(frontendConnect).not.toHaveBeenCalled();
  });

  it('keeps observed terminal records stale and blocks live creation while offline', async () => {
    const host = {
      state: {
        kind: 'degraded',
        situation: 'offline',
        recovery: 'automatic',
      },
      liveAction: {
        kind: 'disabled',
        state: {
          kind: 'degraded',
          situation: 'offline',
          recovery: 'automatic',
        },
      },
    } as ProjectHostAccess;
    const store = new TerminalManagerStore('project-1', 'task-1', host);
    store.list.setValue([]);

    expect(store.observation).toEqual({ kind: 'stale', value: [] });
    await expect(
      store.createTerminal({
        id: 'terminal-offline',
        projectId: 'project-1',
        taskId: 'task-1',
        name: 'Terminal 1',
      })
    ).rejects.toThrow('Live actions are unavailable');
    expect(createTerminal).not.toHaveBeenCalled();
    expect(store.terminals.has('terminal-offline')).toBe(false);
    store.dispose();
  });

  it('keeps a requested session disconnected offline and reconnects it after recovery', async () => {
    listTerminals.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'terminal-1',
          projectId: 'project-1',
          taskId: 'task-1',
          shellId: 'system',
          name: 'Terminal 1',
        },
      ],
    });
    const state = observable.box<ProjectHostAccessState>({
      kind: 'degraded',
      situation: 'offline',
      recovery: 'automatic',
    });
    const hostAccess = {
      get state() {
        return state.get();
      },
      get liveAction() {
        const current = state.get();
        return current.kind === 'ready'
          ? ({ kind: 'enabled' } as const)
          : ({ kind: 'disabled', state: current } as const);
      },
    } as ProjectHostAccess;
    const store = new TerminalManagerStore('project-1', 'task-1', hostAccess);
    store.list.setValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        taskId: 'task-1',
        shellId: 'system',
        name: 'Terminal 1',
      },
    ]);
    const session = store.sessions.get('terminal-1');

    await session?.connect();

    expect(session?.status).toBe('disconnected');
    expect(hydrateTerminal).not.toHaveBeenCalled();

    runInAction(() => state.set({ kind: 'ready', hostGeneration: 2 }));
    await vi.waitFor(() => expect(session?.status).toBe('ready'));
    expect(hydrateTerminal).toHaveBeenCalledTimes(1);
    expect(frontendConnect).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});
