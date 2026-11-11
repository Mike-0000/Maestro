import { installAppDbTestInstance } from '@tooling/vitest/app-db-test-instance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatusSignal } from '@core/primitives/agents/api';
import { setAttentionJudge } from '@core/primitives/agents/api/attention-judge';
import {
  setConductorDecisionPolicy,
  type ConductorDecisionEvent,
  type ConductorDecisionRequest,
} from '@core/primitives/agents/api/conductor-decisions';
import {
  AgentStatusService,
  endsInQuestion,
  setAgentStatusConversationEventPublisher,
} from './agent-status-service';
import type { DecisionClock } from './conductor-decision-gate';

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

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));

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

  describe('running sub-agents', () => {
    const explore = { id: 'a1', label: 'Explore', agentType: 'Explore', startedAt: 5 };

    it('publishes them with a working or asking status, and drops them after', async () => {
      const service = new AgentStatusService();
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('start', { payload: { subAgents: [explore] } }));
      await service.applySignal(
        signal('notification', {
          payload: { notificationType: 'permission_prompt', subAgents: [explore] },
        })
      );
      await service.applySignal(signal('stop', { payload: { subAgents: [explore] } }));

      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({
        status: 'working',
        subAgents: [explore],
      });
      expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({
        status: 'awaiting-input',
        subAgents: [explore],
      });
      expect(mocks.emit.mock.calls[2]?.[1]).toMatchObject({ status: 'completed' });
      expect(mocks.emit.mock.calls[2]?.[1]).not.toHaveProperty('subAgents');
    });

    it('republishes a change as the same turn, with the count kept', async () => {
      const service = new AgentStatusService();
      const handler = vi.fn();
      service.on('agent:event', handler);
      mocks.selectRows.push(row({ agentStatus: 'working', agentStatusSeen: 1 }));

      await service.updateBackgroundAgents(
        signal('start', { payload: { backgroundAgents: 2, subAgents: [explore] } })
      );

      expect(mocks.update).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(mocks.emit).toHaveBeenCalledWith(undefined, {
        type: 'agent-status-changed',
        conversationId: 'conversation-1',
        taskId: 'task-1',
        projectId: 'project-1',
        status: 'working',
        seen: true,
        backgroundAgents: 2,
        subAgents: [explore],
      });
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

  describe('the idle reminder without a verdict', () => {
    const idleReminder = { payload: { notificationType: 'idle_prompt' as const } };
    const done = { payload: { lastAssistantMessage: 'Fixed the login test. All checks pass.' } };
    const asks = { payload: { lastAssistantMessage: 'Fixed the login test.\n\nShall I push it?' } };

    function watched() {
      const service = new AgentStatusService();
      const handler = vi.fn();
      service.on('agent:event', handler);
      return { service, handler };
    }

    it('drops the reminder after a turn that did not end on a question', async () => {
      const { service, handler } = watched();
      mocks.updateRows.push(row());

      await service.applySignal(signal('stop', done));
      await service.applySignal(signal('notification', idleReminder));

      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual(['completed']);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'stop' }));
    });

    it('drops it after a stop with no reply, and after a verdict that failed', async () => {
      const judge = vi.fn().mockRejectedValue(new Error('timed out'));
      setAttentionJudge({ enabled: async () => true, judge });
      try {
        const { service, handler } = watched();
        mocks.updateRows.push(row(), row());

        await service.applySignal(signal('stop'));
        await service.applySignal(signal('notification', idleReminder));
        await service.applySignal(signal('stop', done));
        await service.applySignal(signal('notification', idleReminder));

        expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
          'completed',
          'completed',
        ]);
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        setAttentionJudge(null);
      }
    });

    it('keeps the reminder after a question, with that reply and the seen flag as it was', async () => {
      const { service, handler } = watched();
      // The developer looked at the tile after the stop.
      mocks.updateRows.push(row({ agentStatusSeen: 0 }), row({ agentStatusSeen: 1 }));

      await service.applySignal(signal('stop', asks));
      await service.applySignal(signal('notification', idleReminder));

      expect(mocks.updateCalls).toEqual([
        { agentStatus: 'completed', agentStatusSeen: 0 },
        { agentStatus: 'awaiting-input' },
      ]);
      expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({
        status: 'awaiting-input',
        seen: true,
        completionReport: { text: 'Fixed the login test.\n\nShall I push it?' },
      });
      expect(handler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({ notificationType: 'idle_prompt' }),
        })
      );
    });

    it('reads a chat reply through the stop’s loadReply', async () => {
      const { service } = watched();
      mocks.updateRows.push(row(), row());
      const loadReply = vi.fn(async () => 'Which branch should I use?');

      await service.applySignal(signal('stop'), { loadReply });
      await service.applySignal(signal('notification', idleReminder));

      expect(loadReply).toHaveBeenCalledTimes(1);
      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'completed',
        'awaiting-input',
      ]);
    });

    it('keeps a reminder that is not preceded by a stop: some providers end turns with it', async () => {
      const { service, handler } = watched();
      mocks.updateRows.push(row(), row(), row(), row());

      // A conversation that never sent a stop (OpenCode, Kilo Code, Mimo).
      await service.applySignal(signal('notification', idleReminder));
      // A stop, then new activity before the reminder.
      await service.applySignal(signal('stop', done));
      await service.applySignal(signal('start'));
      await service.applySignal(signal('notification', idleReminder));

      expect(mocks.updateCalls).toEqual([
        { agentStatus: 'awaiting-input', agentStatusSeen: 0 },
        { agentStatus: 'completed', agentStatusSeen: 0 },
        { agentStatus: 'working', agentStatusSeen: 1 },
        { agentStatus: 'awaiting-input', agentStatusSeen: 0 },
      ]);
      expect(handler).toHaveBeenCalledTimes(4);
    });

    it('forgets the turn end once the conversation is reset', async () => {
      const { service } = watched();
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('stop', done));
      await service.resetToIdle({ conversationId: 'conversation-1' });
      await service.applySignal(signal('notification', idleReminder));

      expect(mocks.updateCalls.map((call) => call.agentStatus)).toEqual([
        'completed',
        'idle',
        'awaiting-input',
      ]);
    });

    it('leaves permission and elicitation prompts after a stop alone', async () => {
      const { service, handler } = watched();
      mocks.updateRows.push(row(), row(), row());

      await service.applySignal(signal('stop', done));
      await service.applySignal(
        signal('notification', { payload: { notificationType: 'permission_prompt' } })
      );
      await service.applySignal(
        signal('notification', { payload: { notificationType: 'elicitation_dialog' } })
      );

      expect(mocks.updateCalls).toEqual([
        { agentStatus: 'completed', agentStatusSeen: 0 },
        { agentStatus: 'awaiting-input', agentStatusSeen: 0 },
        { agentStatus: 'awaiting-input', agentStatusSeen: 0 },
      ]);
      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  it('reads a question from the last sentence of a reply', () => {
    for (const reply of [
      'Shall I push it?',
      'Done.\n\nWhich database should I use?  \n',
      '**Want me to open a PR?**',
      'Should I keep `retry()`?`',
      'Proceed with the "safe" option?"',
      '続けますか？',
    ]) {
      expect(endsInQuestion(reply), reply).toBe(true);
    }
    for (const reply of ['', 'All done.', 'Is it safe? Yes, it is.', 'Run `git status?`.']) {
      expect(endsInQuestion(reply), reply).toBe(false);
    }
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

      // Without a verdict the idle reminder counts only after a turn that ended on a question.
      await service.applySignal(signal('notification', idleReminder));
      expect(mocks.updateCalls).toHaveLength(3);
      await service.applySignal(signal('stop', question));
      await service.applySignal(signal('notification', idleReminder));
      expect(mocks.updateCalls[4]).toEqual({ agentStatus: 'awaiting-input' });
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

  describe('with the chat conductor deciding', () => {
    /** Timers that only run when a test fires them. */
    const timers: Array<() => void> = [];
    const clock: DecisionClock = {
      now: () => 1_000,
      setTimeout: (callback) => timers.push(callback),
      clearTimeout: (handle) => {
        timers[(handle as number) - 1] = () => {};
      },
    };
    const events: ConductorDecisionEvent[] = [];
    let enabled = true;

    beforeEach(() => {
      timers.length = 0;
      events.length = 0;
      enabled = true;
      setConductorDecisionPolicy({
        enabled: async () => enabled,
        emit: (event) => events.push(event),
      });
    });
    afterEach(() => setConductorDecisionPolicy(null));

    function claimed() {
      const service = new AgentStatusService(clock);
      const handler = vi.fn();
      service.on('agent:event', handler);
      service.decisions.claim(['conversation-1']);
      return { service, handler };
    }

    const stop = () =>
      signal('stop', { payload: { lastAssistantMessage: 'Which database should I use?' } });
    const request = () =>
      events.find(
        (event): event is ConductorDecisionRequest & { type: 'requested' } =>
          event.type === 'requested'
      )!;

    it('shows and notifies nothing for a held turn end, and asks the conductor', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());

      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.emit).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(service.decisions.isHeld('conversation-1')).toBe(true);
      expect(request()).toMatchObject({
        conversationId: 'conversation-1',
        kind: 'finished',
        completionReport: { text: 'Which database should I use?' },
      });
    });

    it('holds a permission prompt, but never a turn start or an error', async () => {
      const { service } = claimed();
      await service.applySignal(
        signal('notification', { payload: { notificationType: 'permission_prompt' } })
      );
      expect(request()).toMatchObject({
        kind: 'awaiting-input',
        notificationType: 'permission_prompt',
      });

      mocks.updateRows.push(row(), row());
      await service.applySignal(signal('error', { payload: { message: 'rate limit' } }));
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'error' });
      // The error replaced what was held.
      expect(events.at(-1)).toMatchObject({ type: 'closed', reason: 'superseded' });
      await service.applySignal(signal('start'));
      expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({ status: 'working' });
    });

    it('behaves as before for a chat nobody claimed, or with decisions off', async () => {
      const service = new AgentStatusService(clock);
      mocks.updateRows.push(row());
      await service.applySignal(stop());
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'completed' });
      expect(mocks.emit.mock.calls[0]?.[1]).not.toHaveProperty('conductor');

      enabled = false;
      const { service: off } = claimed();
      mocks.updateRows.push(row());
      await off.applySignal(stop());
      expect(mocks.emit).toHaveBeenCalledTimes(2);
      expect(events).toEqual([]);
    });

    it('shows a needs-you decision with its headline, and lets it notify', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());

      expect(
        service.decisions.resolve(request().holdId, 'conversation-1', {
          kind: 'surface',
          state: 'needs_you',
          headline: 'Pick SQLite or Postgres',
          detail: 'It asks which database to use.',
          notify: true,
        })
      ).toBe('decision');
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));

      const conductor = {
        state: 'needs_you',
        headline: 'Pick SQLite or Postgres',
        detail: 'It asks which database to use.',
        notify: true,
      };
      expect(mocks.updateCalls[0]).toEqual({ agentStatus: 'awaiting-input', agentStatusSeen: 0 });
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({
        type: 'agent-status-changed',
        status: 'awaiting-input',
        seen: false,
        completionSummary: 'Pick SQLite or Postgres',
        completionReport: { text: 'Which database should I use?' },
        conductor,
      });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        type: 'notification',
        payload: { notificationType: 'idle_prompt', conductor },
      });
      expect(service.decisions.isHeld('conversation-1')).toBe(false);
    });

    it('shows a quiet turn end as done and seen, without a notification', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      service.decisions.resolve(request().holdId, 'conversation-1', { kind: 'quiet' });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(mocks.updateCalls[0]).toEqual({ agentStatus: 'completed', agentStatusSeen: 1 });
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({
        status: 'completed',
        seen: true,
        conductor: { state: 'quiet', notify: false },
      });
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ type: 'stop' });
    });

    it('keeps a silent dot on a prompt nobody answered, and none on one the conductor answered', async () => {
      const { service, handler } = claimed();
      const prompt = () =>
        service.applySignal(
          signal('notification', { payload: { notificationType: 'permission_prompt' } })
        );
      await prompt();
      mocks.updateRows.push(row(), row());
      service.decisions.resolve(request().holdId, 'conversation-1', { kind: 'quiet' });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({
        status: 'awaiting-input',
        seen: false,
        conductor: { state: 'quiet', notify: false },
      });

      events.length = 0;
      await prompt();
      service.decisions.resolve(request().holdId, 'conversation-1', {
        kind: 'quiet',
        answered: true,
      });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(2));
      expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({ status: 'working', seen: true });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      expect(handler.mock.calls[1]?.[0]).toMatchObject({ type: 'start' });
    });

    it('falls back to the status the event would have had when the conductor cannot decide', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      service.decisions.resolve(request().holdId, 'conversation-1', {
        kind: 'fallback',
        reason: 'budget',
      });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));
      expect(mocks.updateCalls[0]).toEqual({ agentStatus: 'completed', agentStatusSeen: 0 });
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'completed' });
      expect(mocks.emit.mock.calls[0]?.[1]).not.toHaveProperty('conductor');
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(handler.mock.calls[0]?.[0].payload).not.toHaveProperty('conductor');
    });

    it('falls back when the renderer does not acknowledge the request', async () => {
      const { service } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      // The acknowledgement timer is the first one the hold set.
      timers[1]!();
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'completed' });
      expect(events.at(-1)).toMatchObject({ type: 'closed', reason: 'fallback' });
    });

    it('lets a turn start supersede the hold, so nothing of it is ever shown', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());
      const { holdId } = request();
      mocks.updateRows.push(row());
      await service.applySignal(signal('start'));

      expect(events.at(-1)).toMatchObject({ type: 'closed', holdId, reason: 'superseded' });
      expect(service.decisions.resolve(holdId, 'conversation-1', { kind: 'quiet' })).toBe('stale');
      expect(mocks.emit).toHaveBeenCalledTimes(1);
      expect(mocks.emit.mock.calls[0]?.[1]).toMatchObject({ status: 'working' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('drops the idle reminder and snapshots while a decision is pending', async () => {
      const { service } = claimed();
      await service.applySignal(stop());
      await service.applySignal(
        signal('notification', { payload: { notificationType: 'idle_prompt' } })
      );
      await service.cacheSignal(stop());
      expect(mocks.update).not.toHaveBeenCalled();
      expect(service.decisions.isHeld('conversation-1')).toBe(true);
    });

    it('drops the idle reminder after a decided turn', async () => {
      const { service } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      service.decisions.resolve(request().holdId, 'conversation-1', { kind: 'quiet' });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));
      await service.applySignal(
        signal('notification', { payload: { notificationType: 'idle_prompt' } })
      );
      expect(mocks.emit).toHaveBeenCalledTimes(1);
    });

    it('takes a late needs-you after a fallback, notifying only what the fallback did not', async () => {
      const { service, handler } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      const { holdId } = request();
      service.decisions.resolve(holdId, 'conversation-1', { kind: 'fallback', reason: 'error' });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));

      mocks.selectRows.push(row({ agentStatus: 'completed' }));
      mocks.updateRows.push(row());
      const late = {
        kind: 'surface',
        state: 'needs_you',
        headline: 'It needs a decision',
        notify: true,
      } as const;
      expect(service.decisions.resolve(holdId, 'conversation-1', late)).toBe('late');
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(2));
      expect(mocks.emit.mock.calls[1]?.[1]).toMatchObject({
        status: 'awaiting-input',
        conductor: { state: 'needs_you', notify: true },
      });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    });

    it('drops a late decision once the agent is working again', async () => {
      const { service } = claimed();
      await service.applySignal(stop());
      mocks.updateRows.push(row());
      const { holdId } = request();
      service.decisions.resolve(holdId, 'conversation-1', { kind: 'fallback', reason: 'error' });
      await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledTimes(1));

      mocks.selectRows.push(row({ agentStatus: 'working' }));
      expect(service.decisions.resolve(holdId, 'conversation-1', { kind: 'quiet' })).toBe('late');
      // Queued after the late decision on the same conversation: once it ran, so did that.
      await service.updateBackgroundAgents(signal('start'));
      // The late decision read the row, found the agent working, and wrote nothing.
      expect(mocks.select).toHaveBeenCalledTimes(2);
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.emit).toHaveBeenCalledTimes(1);
    });

    it('lets go of a held event when the session ends', async () => {
      const { service } = claimed();
      await service.applySignal(stop());
      await service.resetToIdle({ conversationId: 'conversation-1' });
      expect(service.decisions.isHeld('conversation-1')).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'closed', reason: 'superseded' });
    });
  });
});
