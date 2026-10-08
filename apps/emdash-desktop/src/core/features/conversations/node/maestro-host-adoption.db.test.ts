import {
  remoteDeviceWireContract,
  type RemoteAdoptConversationInput,
  type RemoteControlError,
  type RemoteVoiceState,
} from '@emdash/core/services/remote-control/api';
import { err, ok, type Result } from '@emdash/shared';
import { createEventStreamHost } from '@emdash/wire/live';
import { connect, createController, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createConversationRegistry } from '@core/features/conversations/api/node/registry';
import { installMaestroHostAdoption } from './maestro-host-adoption';

type AdoptResult = Result<{ taskId: string; projectId: string }, RemoteControlError>;

describe('installMaestroHostAdoption', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let emitTask: (task: { id: string }) => void;
  let emitConversation: (conversation: { id: string }) => void;
  let adopt: Mock<(input: RemoteAdoptConversationInput) => Promise<AdoptResult>>;
  let stopHost: () => void;
  let connection: ReturnType<typeof connect>;
  const logger = { warn: vi.fn() };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    logger.warn.mockClear();
    adopt = vi.fn(
      async (): Promise<AdoptResult> => ok({ taskId: 'host-task', projectId: 'host-project' })
    );
    const pair = memoryTransportPair();
    stopHost = serve(
      pair.right,
      createController(remoteDeviceWireContract, {
        remote: {
          overview: expose(remoteDeviceWireContract.remote.overview, {
            snapshot: cell({
              host: { id: 'h', name: 'host', appVersion: '1' },
              projects: [],
              agents: [],
              providers: [],
              defaultProviderId: null,
            }),
          }),
          output: () => {
            throw new Error('unused');
          },
          adoptConversation: (input) => adopt(input),
          voice: {
            state: expose(remoteDeviceWireContract.remote.voice.state, {
              hud: cell<RemoteVoiceState>({
                available: false,
                transcriptionReady: true,
                phase: 'idle',
                activity: '',
                lastUtterance: '',
                reply: '',
                replyAt: 0,
                error: null,
                pending: null,
                plan: null,
                agentNames: [],
                speech: 'device',
              }),
            }),
            events: createEventStreamHost(remoteDeviceWireContract.remote.voice.events),
          },
        },
      })
    );
    connection = connect(pair.left);

    fixture.sqlite
      .prepare(
        `INSERT INTO ssh_connections (id, name, host, port, username, auth_type) VALUES ('maestro-1', 'Studio', 'studio', 443, '', 'agent')`
      )
      .run();
    fixture.sqlite.prepare(`INSERT INTO projects (id, name) VALUES ('p1', 'Project')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status) VALUES ('t1', 'p1', 'Fix the build', 'in_progress')`
      )
      .run();
  });

  afterEach(() => {
    stopHost();
    connection.dispose();
    fixture.close();
  });

  function seedConversation(id: string, host: 'maestro' | 'local'): void {
    createConversationRegistry(fixture.db).register({
      id,
      projectId: 'p1',
      taskId: 't1',
      title: 'Agent',
      provider: 'claude',
      type: 'pty',
      workspacePath: 'C:\\Code\\app',
      location: host === 'maestro' ? 'remote' : 'local',
      sshConnectionId: host === 'maestro' ? 'maestro-1' : null,
    });
  }

  function install(options: { maestro?: boolean; connected?: boolean } = {}) {
    return installMaestroHostAdoption({
      db: fixture.db,
      isMaestroHost: () => options.maestro ?? true,
      connectionFor: async () => (options.connected === false ? undefined : connection),
      onTaskCreated: (handler) => {
        emitTask = handler;
        return () => {};
      },
      onConversationCreated: (handler) => {
        emitConversation = handler;
        return () => {};
      },
      logger,
      wait: async () => {},
    });
  }

  it("asks the host to adopt a new task's conversation, once", async () => {
    seedConversation('c1', 'maestro');
    install();

    emitTask({ id: 't1' });
    emitConversation({ id: 'c1' });

    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    expect(adopt).toHaveBeenCalledWith({
      conversationId: 'c1',
      taskName: 'Fix the build',
      workspacePath: 'C:\\Code\\app',
    });
  });

  it('leaves local conversations and SSH hosts alone', async () => {
    seedConversation('local-1', 'local');
    seedConversation('ssh-1', 'maestro');
    install({ maestro: false });

    emitConversation({ id: 'local-1' });
    emitConversation({ id: 'ssh-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(adopt).not.toHaveBeenCalled();
  });

  it('retries while the host refuses, then succeeds', async () => {
    seedConversation('c1', 'maestro');
    adopt
      .mockResolvedValueOnce(err({ type: 'not-found', message: 'not seen yet' }))
      .mockResolvedValueOnce(ok({ taskId: 'host-task', projectId: 'host-project' }));
    install();

    emitConversation({ id: 'c1' });

    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(2));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('gives up with a warning when the host never connects', async () => {
    seedConversation('c1', 'maestro');
    install({ connected: false });

    emitConversation({ id: 'c1' });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    expect(adopt).not.toHaveBeenCalled();
  });
});
