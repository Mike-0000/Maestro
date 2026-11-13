import type { TerminalDevServerList } from '@emdash/core/runtimes/terminals/api';
import type { TuiAgentDevServerList } from '@emdash/core/runtimes/tui-agents/api';
import type * as WireState from '@emdash/wire/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';
import type { PreviewServer } from '@core/primitives/preview-servers/api';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { createDevServerBridge, type DevServerBridgeDependencies } from './dev-server-bridge';

/**
 * The part of the preview-server service the bridge drives, kept in memory: servers are keyed by
 * workspace and port, removed by source terminal, and a user stop calls the bridge's handler.
 */
function createPreviewServers() {
  const servers = new Map<string, PreviewServer>();
  let stopHandler: ((server: PreviewServer) => Promise<void> | void) | undefined;
  return {
    async registerDetectedTarget(
      target: Parameters<DevServerBridgeDependencies['previewServers']['registerDetectedTarget']>[0]
    ) {
      const id = `local:auto:${target.projectId}:${target.workspaceId}:${target.host}:${target.port}`;
      const server: PreviewServer = {
        id,
        kind: 'direct',
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        source: target.source,
        protocol: target.protocol,
        urlPath: target.urlPath,
        status: { kind: 'ready' },
        host: target.host,
        port: target.port,
      };
      if (!servers.has(id)) servers.set(id, server);
      return servers.get(id)!;
    },
    async handleTerminalSourceClosed(
      input: Parameters<
        DevServerBridgeDependencies['previewServers']['handleTerminalSourceClosed']
      >[0]
    ) {
      for (const [id, server] of servers) {
        if (server.projectId !== input.projectId || server.workspaceId !== input.workspaceId)
          continue;
        if (server.source.kind !== 'terminal-output') continue;
        if (server.source.terminalId !== input.terminalId) continue;
        if (server.kind === 'direct' && server.port !== input.server.port) continue;
        servers.delete(id);
      }
    },
    registerStopTerminalServerHandler(
      _key: string,
      handler: (server: PreviewServer) => Promise<void> | void
    ) {
      stopHandler = handler;
      return () => {
        stopHandler = undefined;
      };
    },
    listForWorkspace({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
      return [...servers.values()].filter(
        (server) => server.projectId === projectId && server.workspaceId === workspaceId
      );
    },
    async stop(id: string) {
      const server = servers.get(id);
      if (!server) return;
      servers.delete(id);
      await stopHandler?.(server);
    },
  };
}

const mocks = vi.hoisted(() => ({
  list: {} as TerminalDevServerList,
  scriptList: {} as Record<string, unknown>,
  observe: vi.fn(),
  remote: vi.fn(),
  whenReady: vi.fn(),
}));

vi.mock('@emdash/wire/state', async (importOriginal) => ({
  ...(await importOriginal<typeof WireState>()),
  observe: mocks.observe,
  remote: mocks.remote,
  whenReady: mocks.whenReady,
}));

describe('createDevServerBridge', () => {
  beforeEach(() => {
    mocks.list = {
      detected: {
        key: {
          workspace: hostFileRefFromNativePath('/repo', 'connection-1'),
          id: 'project-1:workspace-1:terminal-1',
        },
        protocol: 'http:',
        host: 'localhost',
        port: 5173,
        urlPath: '/app',
        detectedAt: 1,
      },
    };
    mocks.scriptList = {};
    mocks.observe.mockReset();
    mocks.remote.mockReset();
    mocks.whenReady.mockReset();
    mocks.remote.mockReturnValue(() => ({ states: { list: {} } }));
    // The bridge observes the terminals list first, then the scripts list.
    mocks.observe
      .mockImplementationOnce(
        (_state: unknown, listener: (snapshot: { value: TerminalDevServerList }) => void) => {
          listener({ value: mocks.list });
          return () => {};
        }
      )
      .mockImplementationOnce(
        (_state: unknown, listener: (snapshot: { value: Record<string, unknown> }) => void) => {
          listener({ value: mocks.scriptList });
          return () => {};
        }
      );
    mocks.whenReady.mockResolvedValue(undefined);
  });

  it('threads SSH host context, matches forwarded previews, and reconciles to empty on dispose', async () => {
    let stopHandler: ((server: PreviewServer) => Promise<void> | void) | undefined;
    const unregisterStopHandler = vi.fn();
    const registerDetectedTarget = vi.fn(async () => undefined);
    const handleTerminalSourceClosed = vi.fn(async () => {});
    const registerStopTerminalServerHandler = vi.fn(
      (_key: string, handler: (server: PreviewServer) => Promise<void> | void) => {
        stopHandler = handler;
        return unregisterStopHandler;
      }
    );
    const resolveWorkspace = vi.fn(async () => ({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    }));
    const dependencies = {
      previewServers: {
        registerDetectedTarget,
        handleTerminalSourceClosed,
        registerStopTerminalServerHandler,
      },
      resolveWorkspace,
    } as unknown as DevServerBridgeDependencies;
    const sendInput = vi.fn(async () => ({ success: true, data: undefined }));
    const bridge = await createDevServerBridge(
      {
        terminals: { devServers: {}, sendInput },
        scripts: { devServers: {}, sendInput: vi.fn() },
      } as never,
      dependencies,
      { transport: 'ssh', connectionId: 'connection-1' }
    );

    expect(registerDetectedTarget).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      transport: 'ssh',
      connectionId: 'connection-1',
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      host: 'localhost',
      port: 5173,
      urlPath: '/app',
    });
    expect(registerStopTerminalServerHandler).toHaveBeenCalledWith(
      'connection-1',
      expect.any(Function)
    );

    await stopHandler?.({
      id: 'ssh:auto:1',
      kind: 'forwarded',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      source: { kind: 'terminal-output', terminalId: 'terminal-1' },
      protocol: 'http:',
      urlPath: '/app',
      status: { kind: 'ready' },
      connectionId: 'connection-1',
      remotePort: 5173,
      localPort: 6173,
    });
    expect(sendInput).toHaveBeenCalledWith({
      key: mocks.list.detected!.key,
      data: '\x03',
    });

    await bridge.dispose();

    expect(handleTerminalSourceClosed).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      terminalId: 'terminal-1',
      transport: 'ssh',
      connectionId: 'connection-1',
      reason: 'source-detached',
      server: {
        protocol: 'http:',
        host: 'localhost',
        port: 5173,
        urlPath: '/app',
      },
    });
    expect(unregisterStopHandler).toHaveBeenCalledOnce();
  });

  it('registers script-plane dev servers under lifecycle terminal ids and interrupts via the scripts runtime', async () => {
    mocks.list = {};
    mocks.scriptList = {
      detected: {
        key: { workspacePath: '/repo', script: 'run' },
        protocol: 'http:',
        host: 'localhost',
        port: 5173,
        urlPath: '/app',
        detectedAt: 1,
      },
    };
    let stopHandler: ((server: PreviewServer) => Promise<void> | void) | undefined;
    const registerDetectedTarget = vi.fn(async () => undefined);
    const dependencies = {
      previewServers: {
        registerDetectedTarget,
        handleTerminalSourceClosed: vi.fn(async () => {}),
        registerStopTerminalServerHandler: vi.fn(
          (_key: string, handler: (server: PreviewServer) => Promise<void> | void) => {
            stopHandler = handler;
            return vi.fn();
          }
        ),
      },
      resolveWorkspace: vi.fn(async () => ({
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      })),
    } as unknown as DevServerBridgeDependencies;
    const terminalSendInput = vi.fn(async () => ({ success: true, data: undefined }));
    const scriptStop = vi.fn(async () => ({ success: true, data: undefined }));
    const bridge = await createDevServerBridge(
      {
        terminals: { devServers: {}, sendInput: terminalSendInput },
        scripts: { devServers: {}, stop: scriptStop },
      } as never,
      dependencies,
      { transport: 'local' }
    );

    expect(registerDetectedTarget).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      transport: 'local',
      source: { kind: 'terminal-output', terminalId: 'script-lifecycle-run' },
      protocol: 'http:',
      host: 'localhost',
      port: 5173,
      urlPath: '/app',
    });

    await stopHandler?.({
      id: 'local:auto:1',
      kind: 'direct',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      source: { kind: 'terminal-output', terminalId: 'script-lifecycle-run' },
      protocol: 'http:',
      host: 'localhost',
      port: 5173,
      urlPath: '/app',
      status: { kind: 'ready' },
    });
    // The stop verb, not a Ctrl-C: the run settles as cancelled in the timeline.
    expect(scriptStop).toHaveBeenCalledWith({
      workspacePath: '/repo',
      script: 'run',
    });
    expect(terminalSendInput).not.toHaveBeenCalled();

    await bridge.dispose();
  });

  it("registers a server in an agent session's process tree as the task's dev server, and removes it when it stops", async () => {
    mocks.list = {};
    mocks.scriptList = {};
    let pushAgentList: ((list: TuiAgentDevServerList) => void) | undefined;
    const previewServers = createPreviewServers();
    const resolveWorkspace = vi.fn(async (workspacePath: string) =>
      workspacePath === '/repo' ? { projectId: 'project-1', workspaceId: 'workspace-1' } : null
    );
    const terminalSendInput = vi.fn(async () => ({ success: true, data: undefined }));
    const workspaceUrls = () =>
      previewServers
        .listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
        .map((server) => previewServerUrl(server));

    // Without the agent source (the bridge before this change), nothing reports the server.
    const before = await createDevServerBridge(
      {
        terminals: { devServers: {}, sendInput: terminalSendInput },
        scripts: { devServers: {}, stop: vi.fn() },
      } as never,
      { previewServers, resolveWorkspace },
      { transport: 'local' }
    );
    expect(workspaceUrls()).toEqual([]);
    await before.dispose();

    mocks.observe
      .mockImplementationOnce(
        (_state: unknown, listener: (snapshot: { value: TerminalDevServerList }) => void) => {
          listener({ value: {} });
          return () => {};
        }
      )
      .mockImplementationOnce(
        (_state: unknown, listener: (snapshot: { value: Record<string, unknown> }) => void) => {
          listener({ value: {} });
          return () => {};
        }
      )
      .mockImplementationOnce(
        (_state: unknown, listener: (snapshot: { value: TuiAgentDevServerList }) => void) => {
          pushAgentList = (value) => listener({ value });
          // Agent 100 started 101, which started 102: the server on 4100 is the task's.
          listener({
            value: {
              'conversation-1:4100': {
                conversationId: 'conversation-1',
                cwd: '/repo',
                protocol: 'http:',
                host: 'localhost',
                port: 4100,
                urlPath: '/',
                pid: 102,
                detectedAt: 1,
              },
            },
          });
          return () => {};
        }
      );
    const bridge = await createDevServerBridge(
      {
        terminals: { devServers: {}, sendInput: terminalSendInput },
        scripts: { devServers: {}, stop: vi.fn() },
        tuiAgents: { devServers: {} },
      } as never,
      { previewServers, resolveWorkspace },
      { transport: 'local' }
    );

    expect(workspaceUrls()).toEqual(['http://localhost:4100/']);
    expect(
      previewServers.listForWorkspace({ projectId: 'project-1', workspaceId: 'workspace-1' })
    ).toMatchObject([{ source: { kind: 'terminal-output', terminalId: 'agent:conversation-1' } }]);

    // The listener went away: the runtime dropped it, and so does the task.
    pushAgentList?.({});
    await vi.waitFor(() => expect(workspaceUrls()).toEqual([]));

    // Stopping an agent's server from the preview never types into a terminal.
    pushAgentList?.({
      'conversation-1:4100': {
        conversationId: 'conversation-1',
        cwd: '/repo',
        protocol: 'http:',
        host: 'localhost',
        port: 4100,
        urlPath: '/',
        pid: 102,
        detectedAt: 2,
      },
    });
    await vi.waitFor(() => expect(workspaceUrls()).toEqual(['http://localhost:4100/']));
    const [server] = previewServers.listForWorkspace({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    await previewServers.stop(server!.id);
    expect(terminalSendInput).not.toHaveBeenCalled();

    await bridge.dispose();
    expect(workspaceUrls()).toEqual([]);
  });
});
