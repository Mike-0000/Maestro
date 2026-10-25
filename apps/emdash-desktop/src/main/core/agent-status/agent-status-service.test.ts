import { installAppDbTestInstance } from '@tooling/vitest/app-db-test-instance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatusSignal } from '@core/primitives/agents/api';
import { setAttentionJudge } from '@core/primitives/agents/api/attention-judge';
import {
  AgentStatusService,
  setAgentStatusConversationEventPublisher,
} from './agent-status-service';

type TestConversationRow = {
  projectId: string;
  taskId: string;
  providerId: string | null;
  agentStatusSeen: number | null;
  agentStatus?: string;
};

const mocks = vi.hoisted(() => ({
  blockUpdates: false,
  emit: vi.fn(),
  select: vi.fn(),
  selectRows: [] as Array<TestConversationRow | null>,
  update: vi.fn(),
  updateCalls: [] as Array<Record<string, unknown>>,
  updateRows: [] as Array<TestConversationRow | null>,
  updateResolvers: [] as Array<() => void>,
}));

mocks.select.mockImplementation(() => ({
  from: () => ({
    where: () => ({
      limit: async () => {
        const row = mocks.selectRows.shift();
        return row ? [row] : [];
      },
    }),
  }),
}));
mocks.update.mockImplementation(() => ({
  set: (values: Record<string, unknown>) => {
    mocks.updateCalls.push(values);
    return {
      where: () => ({
        returning: async () => {
          const row = mocks.updateRows.shift();
          if (mocks.blockUpdates) {
            await new Promise<void>((resolve) => mocks.updateResolvers.push(resolve));
          }
          return row ? [row] : [];
        },
      }),
    };
  },
}));
installAppDbTestInstance(() => ({ select: mocks.select, update: mocks.update }) as never);

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));

function row(overrides: Partial<TestConversationRow> = {}): TestConversationRow {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'codex',
    agentStatusSeen: 1,
    ...overrides,
  };
}

function signal(
  type: AgentStatusSignal['type'],
  overrides: Partial<AgentStatusSignal> = {}
): AgentStatusSignal {
  return {
    type,
    conversationId: 'conversation-1',
    timestamp: 1,
    payload: {},
    ...overrides,
  };
}

function resolveUpdate(index: number): void {
  const resolve = mocks.updateResolvers[index];
  if (!resolve) throw new Error(`Missing update resolver at index ${index}`);
  resolve();
}

describe('AgentStatusService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAgentStatusConversationEventPublisher((event) => mocks.emit(undefined, event));
    mocks.blockUpdates = false;
    mocks.selectRows.length = 0;
    mocks.updateCalls.length = 0;
    mocks.updateRows.length = 0;
    mocks.updateResolvers.length = 0;
  });

  it('serializes each conversation while allowing other conversations to progress', async () => {
    const service = new AgentStatusService();
    mocks.blockUpdates = true;
    mocks.updateRows.push(row(), row({ projectId: 'project-2', taskId: 'task-2' }), row());

    const first = service.applySignal(signal('start'));
    const second = service.applySignal(signal('stop', { timestamp: 2 }));
    const interleaved = service.applySignal(
      signal('error', { conversationId: 'conversation-2', timestamp: 3 })
    );

    await vi.waitFor(() => expect(mocks.updateCalls).toHaveLength(2));
    expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual(['working', 'error']);

    resolveUpdate(1);
    await interleaved;
    expect(mocks.updateCalls).toHaveLength(2);

    resolveUpdate(0);
    await vi.waitFor(() => expect(mocks.updateCalls).toHaveLength(3));
    expect(mocks.updateCalls[2]?.agentStatus).toBe('completed');
    resolveUpdate(2);

    await Promise.all([first, second]);
  });

  it('drops a signal when its conversation no longer exists', async () => {
    const service = new AgentStatusService();
    mocks.updateRows.push(null);

    await service.applySignal(signal('start'));

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('enriches delivered signals and falls back to the stored provider', async () => {
    const service = new AgentStatusService();
    const handler = vi.fn();
    service.on('agent:event', handler);
    mocks.updateRows.push(row({ providerId: 'claude' }));

    await service.applySignal(signal('start'));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        projectId: 'project-1',
        taskId: 'task-1',
        providerId: 'claude',
      })
    );
  });

  it('delivers hooks only after the status write completes', async () => {
    const service = new AgentStatusService();
    const handler = vi.fn();
    service.on('agent:event', handler);
    mocks.blockUpdates = true;
    mocks.updateRows.push(row());

    const pending = service.applySignal(signal('start'));
    await vi.waitFor(() => expect(mocks.updateCalls).toHaveLength(1));

    expect(handler).not.toHaveBeenCalled();

    resolveUpdate(0);
    await pending;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('caches snapshots without delivering hooks and preserves the seen flag', async () => {
    const service = new AgentStatusService();
    const handler = vi.fn();
    service.on('agent:event', handler);
    mocks.updateRows.push(row({ agentStatusSeen: 1 }));

    await service.cacheSignal(signal('stop'));

    expect(handler).not.toHaveBeenCalled();
    expect(mocks.updateCalls).toEqual([{ agentStatus: 'completed' }]);
    expect(mocks.emit).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ status: 'completed', seen: true })
    );
  });

  it('publishes the awaited subagent count with a working status, and drops it after', async () => {
    const service = new AgentStatusService();
    mocks.updateRows.push(row(), row());

    await service.applySignal(signal('start', { payload: { backgroundAgents: 7 } }));
    await service.applySignal(signal('stop', { payload: { backgroundAgents: 7 } }));

    expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'working', backgroundAgents: 7 });
    expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({ status: 'completed' });
    expect(mocks.emit.mock.calls[1]?.[1]).not.toHaveProperty('backgroundAgents');
  });

  it('republishes a count change as the same turn: no write or agent event', async () => {
    const service = new AgentStatusService();
    const handler = vi.fn();
    service.on('agent:event', handler);
    mocks.selectRows.push(row({ agentStatus: 'working', agentStatusSeen: 0 }));

    await service.updateBackgroundAgents(signal('start', { payload: { backgroundAgents: 6 } }));

    expect(mocks.update).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(undefined, {
      type: 'agent-status-changed',
      conversationId: 'conversation-1',
      taskId: 'task-1',
      projectId: 'project-1',
      status: 'working',
      seen: false,
      backgroundAgents: 6,
    });
  });

  it('ignores a count change for a conversation no longer shown as working', async () => {
    const service = new AgentStatusService();
    mocks.selectRows.push(row({ agentStatus: 'awaiting-input' }));

    await service.updateBackgroundAgents(signal('start', { payload: { backgroundAgents: 5 } }));

    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('publishes a completion synopsis, never the full final reply', async () => {
    const service = new AgentStatusService();
    mocks.updateRows.push(row(), row());
    const reply =
      'I fixed the flaky login test and added a retry guard.\n\n```\nTOKEN=abc123 npm test\n```';

    await service.applySignal(signal('stop', { payload: { lastAssistantMessage: reply } }));
    await service.applySignal(signal('start', { payload: { lastAssistantMessage: reply } }));

    const [completed, working] = mocks.emit.mock.calls.map((call) => call[1]);
    expect(completed).toMatchObject({
      status: 'completed',
      completionSummary: 'fixed the flaky login test and added a retry guard',
      completionReport: { truncated: false, appUrls: [] },
    });
    expect(completed.completionReport.text).toContain('I fixed the flaky login test');
    expect(JSON.stringify(completed)).not.toContain('abc123');
    expect(working).not.toHaveProperty('completionSummary');
    expect(working).not.toHaveProperty('completionReport');
  });

  it('publishes a null synopsis when the stop signal has no final reply', async () => {
    const service = new AgentStatusService();
    mocks.updateRows.push(row());

    await service.applySignal(signal('stop'));

    expect(mocks.emit).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        status: 'completed',
        completionSummary: null,
        completionReport: null,
      })
    );
  });

  it('waits for queued writes before disposing', async () => {
    const service = new AgentStatusService();
    mocks.blockUpdates = true;
    mocks.updateRows.push(row());

    const pending = service.applySignal(signal('start'));
    await vi.waitFor(() => expect(mocks.updateCalls).toHaveLength(1));

    let disposed = false;
    const disposal = Promise.resolve(service.dispose()).then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveUpdate(0);
    await Promise.all([pending, disposal]);
    expect(disposed).toBe(true);
  });

  describe('with the conductor judging finished turns', () => {
    const judge = vi.fn();
    const question = { payload: { lastAssistantMessage: 'Which database should I use?' } };
    const idleReminder = { payload: { notificationType: 'idle_prompt' as const } };

    beforeEach(() => {
      judge.mockReset();
      setAttentionJudge({ enabled: async () => true, judge });
    });

    afterEach(() => setAttentionJudge(null));

    it('turns a stop the agent cannot go on from into awaiting-input, with its reply', async () => {
      const service = new AgentStatusService();
      const handler = vi.fn();
      service.on('agent:event', handler);
      judge.mockResolvedValue({ needsDeveloper: true, reason: 'Asks which database to use.' });
      mocks.updateRows.push(row());

      await service.applySignal(signal('stop', question));

      expect(judge).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conversation-1',
          reply: 'Which database should I use?',
        })
      );
      expect(mocks.updateCalls[0]).toMatchObject({ agentStatus: 'awaiting-input' });
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({
        status: 'awaiting-input',
        completionReport: { text: 'Which database should I use?' },
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({ notificationType: 'idle_prompt' }),
        })
      );
    });

    it('keeps the status unwritten until the verdict arrives', async () => {
      const service = new AgentStatusService();
      let answer: (verdict: { needsDeveloper: boolean; reason: string }) => void = () => {};
      judge.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      mocks.updateRows.push(row());

      const pending = service.applySignal(signal('stop', question));
      await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1));
      expect(mocks.updateCalls).toHaveLength(0);

      answer({ needsDeveloper: false, reason: 'Done.' });
      await pending;
      expect(mocks.updateCalls[0]).toMatchObject({ agentStatus: 'completed' });
    });

    it('ignores the idle reminder after a verdict, until the agent moves on', async () => {
      const service = new AgentStatusService();
      judge.mockResolvedValue({ needsDeveloper: false, reason: 'Done.' });
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('stop', { payload: { lastAssistantMessage: 'All done.' } }));
      await service.applySignal(signal('notification', idleReminder));
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual(['completed']);

      await service.applySignal(signal('start'));
      await service.applySignal(signal('notification', idleReminder));
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'completed',
        'working',
        'awaiting-input',
      ]);
    });

    it('falls back to the plain stop when there is no verdict', async () => {
      const service = new AgentStatusService();
      judge.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
      mocks.updateRows.push(row(), row(), row(), row());

      await service.applySignal(signal('stop', question));
      await service.applySignal(signal('stop', question));
      // No reply to read: nothing is asked.
      await service.applySignal(signal('stop'));
      expect(judge).toHaveBeenCalledTimes(2);
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'completed',
        'completed',
        'completed',
      ]);

      // Without a verdict the idle reminder still counts, as before.
      await service.applySignal(signal('notification', idleReminder));
      expect(mocks.updateCalls[3]).toMatchObject({ agentStatus: 'awaiting-input' });
    });

    it('asks once for the same reply and reads a chat reply through loadReply', async () => {
      const service = new AgentStatusService();
      judge.mockResolvedValue({ needsDeveloper: true, reason: 'Needs a sign-in.' });
      const loadReply = vi.fn(async () => 'Please sign in so I can continue.');
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('stop'), { loadReply });
      await service.applySignal(signal('start'));
      await service.applySignal(signal('stop'), { loadReply });

      expect(judge).toHaveBeenCalledTimes(1);
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'awaiting-input',
        'working',
        'awaiting-input',
      ]);
    });

    it('does not let a restored snapshot undo the verdict on the same turn', async () => {
      const service = new AgentStatusService();
      judge.mockResolvedValue({ needsDeveloper: true, reason: 'Asks which database to use.' });
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('stop', question));
      await service.cacheSignal(signal('stop', question));
      await service.cacheSignal(signal('notification', idleReminder));

      expect(judge).toHaveBeenCalledTimes(1);
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'awaiting-input',
        'awaiting-input',
      ]);

      // A snapshot of a later turn is not the turn that was judged.
      await service.cacheSignal(
        signal('stop', { payload: { lastAssistantMessage: 'Finished the migration.' } })
      );
      expect(mocks.updateCalls[2]).toMatchObject({ agentStatus: 'completed' });
    });

    it('drops a held turn end the agent has already moved on from', async () => {
      const service = new AgentStatusService();
      const handler = vi.fn();
      service.on('agent:event', handler);
      let answer: (verdict: { needsDeveloper: boolean; reason: string }) => void = () => {};
      judge.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      mocks.updateRows.push(row());

      const stopped = service.applySignal(signal('stop', question));
      await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1));
      const started = service.applySignal(signal('start'));
      answer({ needsDeveloper: true, reason: 'Asks which database to use.' });
      await Promise.all([stopped, started]);

      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual(['working']);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'start' }));
    });

    it('does not let a subagent count change overtake a held turn end', async () => {
      const service = new AgentStatusService();
      let answer: (verdict: { needsDeveloper: boolean; reason: string }) => void = () => {};
      judge.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      mocks.updateRows.push(row());
      mocks.selectRows.push(row({ agentStatus: 'completed' }));

      const stopped = service.applySignal(signal('stop', question));
      await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1));
      const counted = service.updateBackgroundAgents(
        signal('start', { payload: { backgroundAgents: 2 } })
      );
      answer({ needsDeveloper: true, reason: 'Asks which database to use.' });
      await Promise.all([stopped, counted]);

      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual(['awaiting-input']);
    });
  });
});
