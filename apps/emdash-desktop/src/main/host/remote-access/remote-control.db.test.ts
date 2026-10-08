import type { TuiAgentState, TuiSessionState } from '@emdash/core/runtimes/tui-agents/api';
import { remoteDeviceWireContract } from '@emdash/core/services/remote-control/api';
import { ok } from '@emdash/shared';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import { createInProcessWire } from '@emdash/wire/rpc';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import type { CreateTaskParams } from '@core/primitives/tasks/api';
import {
  createRemoteControl,
  loadOverview,
  taskNameFromPrompt,
  type RemoteControlPorts,
} from './remote-control';
import { idleRemoteVoice } from './testing';

describe('remote control', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let scope: Scope;
  let agents: Map<string, TuiAgentState>;
  let sessions: Map<string, TuiSessionState>;
  let created: CreateTaskParams[];
  let ports: RemoteControlPorts;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    scope = createScope({ label: 'remote-control-test' });
    agents = new Map();
    sessions = new Map();
    created = [];
    ports = {
      db: fixture.db,
      hostInfo: () => ({ id: 'host-1', name: 'studio', appVersion: '1.0.0' }),
      listProviders: async () => [
        { id: 'codex', name: 'Codex' },
        { id: 'claude', name: 'Claude Code' },
      ],
      createTask: vi.fn(async (params: CreateTaskParams) => {
        created.push(params);
        fixture.sqlite
          .prepare(
            `INSERT INTO tasks (id, project_id, name, status) VALUES (?, ?, ?, 'in_progress')`
          )
          .run(params.id, params.projectId, params.taskConfig.name);
        return ok({ task: { id: params.id } } as never);
      }),
      provisionTask: vi.fn(async () => ({ success: true as const })),
      hydrateConversation: vi.fn(async () => ({ success: true as const })),
      linkConversationToTask: vi.fn(async ({ conversationId, projectId, taskId }) => {
        createConversationRegistry(fixture.db).annotate(conversationId, { projectId, taskId });
      }),
      terminal: {
        output: () => {
          throw new Error('not used');
        },
        sendInput: vi.fn(async () => ({ success: true as const })),
        resize: vi.fn(async () => ({
          success: false as const,
          error: { type: 'not-found', message: 'No terminal' },
        })),
      },
      voice: idleRemoteVoice(),
      sessions: {
        describe: (conversationId) => ({
          agent: agents.get(conversationId),
          session: sessions.get(conversationId),
        }),
        onChanged: () => () => {},
      },
    };
  });

  afterEach(async () => {
    await scope.dispose();
    fixture.close();
  });

  function seedProject(id: string, path: string): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO workspaces (id, type, kind, location, path) VALUES (?, 'local', 'repository', 'local', ?)`
      )
      .run(`ws-${id}`, path);
    fixture.sqlite
      .prepare(`INSERT INTO projects (id, name, repository_workspace_id) VALUES (?, ?, ?)`)
      .run(id, `Project ${id}`, `ws-${id}`);
  }

  function seedTask(id: string, projectId: string, archived = false): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status, archived_at) VALUES (?, ?, ?, 'in_progress', ?)`
      )
      .run(id, projectId, `Task ${id}`, archived ? '2026-01-01 00:00:00' : null);
  }

  function seedConversation(
    id: string,
    link: { projectId: string; taskId: string } | null,
    type: 'pty' | 'acp' = 'pty'
  ): void {
    createConversationRegistry(fixture.db).register({
      id,
      projectId: link?.projectId ?? null,
      taskId: link?.taskId ?? null,
      title: `Agent ${id}`,
      provider: 'claude',
      type,
      location: 'local',
      sshConnectionId: null,
    });
  }

  function api() {
    const control = createRemoteControl(ports, scope);
    const wire = createInProcessWire(remoteDeviceWireContract, { remote: control.impl });
    scope.add(() => wire.dispose());
    return wire.client.remote;
  }

  it('lists every linked agent with live detail and leaves unlinked conversations out', async () => {
    seedProject('p1', 'C:\\Code\\app');
    seedTask('t1', 'p1');
    seedTask('t2', 'p1', true);
    seedConversation('c1', { projectId: 'p1', taskId: 't1' });
    seedConversation('c2', { projectId: 'p1', taskId: 't2' }, 'acp');
    seedConversation('orphan', null);
    agents.set('c1', {
      conversationId: 'c1',
      status: 'awaiting-input',
      message: 'Allow running pnpm test?',
      lastAssistantMessage: 'I need to run the tests.',
      updatedAt: 5_000_000_000_000,
    });
    sessions.set('c1', {
      conversationId: 'c1',
      sessionId: null,
      status: 'running',
      cols: 120,
      rows: 40,
      resume: null,
      startedAt: 1,
    });

    const overview = await loadOverview(ports);

    expect(overview.projects).toEqual([
      { id: 'p1', name: 'Project p1', path: 'C:\\Code\\app', local: true },
    ]);
    expect(overview.defaultProviderId).toBe('claude');
    expect(overview.agents.map((agent) => agent.conversationId)).toEqual(['c1', 'c2']);
    expect(overview.agents[0]).toMatchObject({
      taskName: 'Task t1',
      kind: 'terminal',
      status: 'awaiting-input',
      needsAttention: true,
      running: true,
      message: 'Allow running pnpm test?',
      archived: false,
    });
    expect(overview.agents[1]).toMatchObject({ kind: 'chat', status: 'idle', archived: true });
  });

  it('starts an agent in the project directory and launches its session', async () => {
    seedProject('p1', '/code/app');

    const result = await api().startAgent({
      projectId: 'p1',
      prompt: '  Add a /version endpoint\nwith a test  ',
    });

    expect(result.success).toBe(true);
    const params = created[0]!;
    expect(params.taskConfig.name).toBe('Add a /version endpoint');
    expect(params.taskConfig.initialConversation).toMatchObject({
      provider: 'claude',
      type: 'pty',
      initialPrompt: 'Add a /version endpoint\nwith a test',
    });
    expect(params.workspaceConfig).toEqual({
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-p1' },
    });
    expect(ports.provisionTask).toHaveBeenCalledWith(params.id);
    expect(ports.hydrateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: params.id, initialSize: { cols: 120, rows: 36 } })
    );
  });

  it('refuses to start an agent in an unknown project or with an unknown provider', async () => {
    seedProject('p1', '/code/app');
    const remote = api();
    expect(await remote.startAgent({ projectId: 'nope', prompt: 'hi' })).toMatchObject({
      success: false,
      error: { type: 'not-found' },
    });
    expect(
      await remote.startAgent({ projectId: 'p1', prompt: 'hi', providerId: 'missing' })
    ).toMatchObject({ success: false, error: { type: 'not-found' } });
    expect(created).toHaveLength(0);
  });

  it('opens a terminal agent by ensuring its session and reporting the host terminal size', async () => {
    seedProject('p1', '/code/app');
    seedTask('t1', 'p1');
    seedConversation('c1', { projectId: 'p1', taskId: 't1' });
    sessions.set('c1', {
      conversationId: 'c1',
      sessionId: null,
      status: 'running',
      cols: 132,
      rows: 43,
      resume: null,
      startedAt: 1,
    });

    expect(await api().openAgent({ conversationId: 'c1' })).toEqual({
      success: true,
      data: { kind: 'terminal', running: true, size: { cols: 132, rows: 43 } },
    });
    expect(ports.hydrateConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      taskId: 't1',
      conversationId: 'c1',
      initialSize: { cols: 120, rows: 36 },
    });
  });

  it('does not launch anything for a chat agent', async () => {
    seedProject('p1', '/code/app');
    seedTask('t1', 'p1');
    seedConversation('c1', { projectId: 'p1', taskId: 't1' }, 'acp');

    expect(await api().openAgent({ conversationId: 'c1' })).toMatchObject({
      success: true,
      data: { kind: 'chat' },
    });
    expect(ports.hydrateConversation).not.toHaveBeenCalled();
  });

  it('maps terminal failures to remote errors', async () => {
    expect(await api().resize({ conversationId: 'c1', cols: 80, rows: 24 })).toEqual({
      success: false,
      error: { type: 'not-found', message: 'No terminal' },
    });
  });

  it('adopts a conversation another Maestro started into a task on the matching project', async () => {
    seedProject('p1', 'C:\\Code\\App');
    seedConversation('remote-conv', null);

    const result = await api().adoptConversation({
      conversationId: 'remote-conv',
      taskName: 'Fix the build',
      workspacePath: 'c:/code/app/',
    });

    expect(result.success).toBe(true);
    const params = created[0]!;
    expect(params).toMatchObject({
      projectId: 'p1',
      taskConfig: { name: 'Fix the build' },
      workspaceConfig: { workspace: { kind: 'repository-instance', workspaceId: 'ws-p1' } },
    });
    expect(createConversationRegistry(fixture.db).getLive('remote-conv')).toMatchObject({
      projectId: 'p1',
      taskId: params.id,
      isInitialConversation: true,
    });
  });

  it('returns the existing task when the conversation is already adopted', async () => {
    seedProject('p1', '/code/app');
    seedTask('t1', 'p1');
    seedConversation('c1', { projectId: 'p1', taskId: 't1' });

    expect(
      await api().adoptConversation({
        conversationId: 'c1',
        taskName: 'ignored',
        workspacePath: '/code/app',
      })
    ).toEqual({ success: true, data: { taskId: 't1', projectId: 'p1' } });
    expect(created).toHaveLength(0);
  });

  it('adopts a worktree conversation into the project that owns the worktree', async () => {
    seedProject('p1', '/code/app');
    fixture.sqlite
      .prepare(
        `INSERT INTO workspaces (id, type, kind, location, path, parent_id) VALUES ('wt-1', 'local', 'worktree', 'local', '/code/worktrees/feature', 'ws-p1')`
      )
      .run();
    seedConversation('c1', null);

    const result = await api().adoptConversation({
      conversationId: 'c1',
      taskName: 'Feature',
      workspacePath: '/code/worktrees/feature',
    });

    expect(result.success).toBe(true);
    expect(created[0]).toMatchObject({
      projectId: 'p1',
      workspaceConfig: { workspace: { workspaceId: 'wt-1' } },
    });
  });
});

describe('taskNameFromPrompt', () => {
  it('uses the first line and shortens long ones at a word', () => {
    expect(taskNameFromPrompt('\n  Fix login  \nmore')).toBe('Fix login');
    expect(taskNameFromPrompt('')).toBe('New agent');
    const long = taskNameFromPrompt(
      'Refactor the authentication middleware so that it supports rotating refresh tokens'
    );
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
  });
});
