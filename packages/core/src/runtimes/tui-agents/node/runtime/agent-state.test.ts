import { noopLogger, type Logger } from '@emdash/shared/logger';
import { peek } from '@emdash/wire/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTuiAgentStatesLiveModel,
  createTuiAgentStatesListModel,
  createTuiSessionsLiveModel,
  createTuiSessionsListModel,
  produceCell,
} from '#runtimes/tui-agents/node/state/live-models';
import type { BackgroundWork } from '#services/agent-plugins/api/plugins';
import { SUB_AGENT_PUBLISH_DELAY_MS, TuiAgentStates } from './agent-state';

function createTracker(logger?: Logger, now: () => number = () => 1_000) {
  const sessionsLiveModel = createTuiSessionsLiveModel();
  const agentStatesLiveModel = createTuiAgentStatesLiveModel();
  const sessions = createTuiSessionsListModel(sessionsLiveModel);
  const agentStates = createTuiAgentStatesListModel(agentStatesLiveModel);
  const onSessionIdChanged = vi.fn();
  const onAgentStateChanged = vi.fn();
  const tracker = new TuiAgentStates(
    sessions,
    agentStates,
    now,
    onSessionIdChanged,
    onAgentStateChanged,
    logger
  );
  return { tracker, sessions, agentStates, onSessionIdChanged, onAgentStateChanged };
}

describe('TuiAgentStates late prompt report', () => {
  const hooked = { hooks: { kind: 'http', supportedEvents: ['start'] } } as never;
  const start = { kind: 'status', type: 'start' } as never;

  function setup() {
    let time = 0;
    const warn = vi.fn();
    const { tracker } = createTracker({ warn } as unknown as Logger, () => time);
    return { tracker, warn, advance: (ms: number) => (time += ms) };
  }

  it('reports an agent that took over a second to report a submitted prompt', () => {
    const { tracker, warn, advance } = setup();

    tracker.markInputSubmitted('c1', hooked, '\r');
    advance(12_000);
    tracker.applyCanonicalEvent('c1', 'claude', start);

    expect(warn).toHaveBeenCalledWith('TuiAgentStates: agent reported the submitted prompt late', {
      conversationId: 'c1',
      elapsedMs: 12_000,
    });
  });

  it('stays quiet for a prompt reported promptly, and for later starts in that turn', () => {
    const { tracker, warn, advance } = setup();

    tracker.markInputSubmitted('c1', hooked, '\r');
    advance(999);
    tracker.applyCanonicalEvent('c1', 'claude', start);
    advance(60_000);
    tracker.applyCanonicalEvent('c1', 'claude', start);

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not tie a start to an Enter that answered a menu long ago', () => {
    const { tracker, warn, advance } = setup();

    tracker.markInputSubmitted('c1', hooked, '\r');
    advance(5 * 60_000);
    tracker.applyCanonicalEvent('c1', 'claude', start);

    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores keys other than Enter', () => {
    const { tracker, warn, advance } = setup();

    tracker.markInputSubmitted('c1', hooked, 'hello');
    advance(12_000);
    tracker.applyCanonicalEvent('c1', 'claude', start);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('TuiAgentStates', () => {
  it('maps canonical status hook events to agent state', () => {
    const { tracker, agentStates } = createTracker();

    tracker.applyCanonicalEvent('conv-1', 'codex', {
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
      message: 'approve command',
    });

    expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
      conversationId: 'conv-1',
      providerId: 'codex',
      status: 'awaiting-input',
      source: 'hook',
      notificationType: 'permission_prompt',
      message: 'approve command',
      updatedAt: expect.any(Number),
    });
  });

  describe('background work', () => {
    const start = { kind: 'status', type: 'start' } as const;
    const wakeUp = { kind: 'status', type: 'start', initiator: 'background' } as const;
    const shell = (id: string): BackgroundWork => ({ id: `task:${id}`, kind: 'process' });
    const agent = (id: string): BackgroundWork => ({ id: `task:${id}`, kind: 'agent' });
    const stop = (backgroundWork?: BackgroundWork[]) =>
      ({ kind: 'status', type: 'stop', backgroundWork, lastAssistantMessage: 'report' }) as const;
    const statuses = (onAgentStateChanged: ReturnType<typeof vi.fn>) =>
      onAgentStateChanged.mock.calls.map(([, state]) => state.status);

    it('keeps the agent working when its turn ends waiting on a background shell', () => {
      const { tracker, agentStates, onAgentStateChanged } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('build')]));

      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });

      // The provider's idle reminder fires a minute into the wait.
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'idle_prompt',
        message: 'Claude is waiting for your input',
      });

      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
      expect(statuses(onAgentStateChanged)).not.toContain('completed');
      expect(statuses(onAgentStateChanged)).not.toContain('awaiting-input');

      // The shell exits; the provider wakes the session and the follow-up turn ends clean.
      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([]));

      const state = peek(agentStates.states.list)['conv-1'];
      expect(state).toMatchObject({ status: 'completed', lastAssistantMessage: 'report' });
      expect(state?.awaitingBackgroundWork).toBeUndefined();
    });

    it('still completes a turn that leaves nothing in flight', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop());

      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');
    });

    it('stays working across a wake-up while other launched work is still running', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('build'), shell('publish')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('publish')]));

      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });
    });

    it('surfaces a permission prompt raised while waiting on background work', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('build')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      });

      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'awaiting-input',
        notificationType: 'permission_prompt',
      });
    });

    it('keeps ignoring the idle reminder after a permission prompt interrupts the wait', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('build')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'permission_prompt',
      });
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'idle_prompt',
      });

      expect(peek(agentStates.states.list)['conv-1']?.notificationType).toBe('permission_prompt');
    });

    it('ignores the idle reminder for a restored session that was waiting', () => {
      const { tracker, agentStates } = createTracker();

      tracker.restore({
        conversationId: 'conv-1',
        providerId: 'claude',
        status: 'working',
        source: 'hook',
        awaitingBackgroundWork: true,
        updatedAt: 1,
      });
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'idle_prompt',
      });

      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
    });

    it('still reports the idle reminder when no background work is awaited', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([]));
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'idle_prompt',
      });

      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'awaiting-input',
        notificationType: 'idle_prompt',
      });
    });

    it('completes a later user turn even though earlier work, like a dev server, runs on', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');

      // Work launched by the later turn holds completion again.
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server'), shell('tests')]));
      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });
    });

    it('waits for every subagent across user follow-ups and relays until the last reports', () => {
      // The real sequence: 7 subagents launched, then a developer follow-up mid-wait, then one
      // wake-up per returning subagent.
      const { tracker, agentStates, onAgentStateChanged } = createTracker();
      const agents = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map(agent);

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(agents));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(agents));
      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });

      for (let remaining = 6; remaining >= 1; remaining--) {
        tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
        tracker.applyCanonicalEvent('conv-1', 'claude', stop(agents.slice(0, remaining)));
        expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
      }
      expect(statuses(onAgentStateChanged)).not.toContain('completed');

      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');
      expect(statuses(onAgentStateChanged).filter((s) => s === 'completed')).toHaveLength(1);
    });

    it('waits on a new subagent while ignoring an acknowledged dev server', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server'), agent('review')]));
      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });

      // A further user prompt acknowledges nothing new: the subagent still holds.
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server'), agent('review')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');
    });

    it('lets a user prompt acknowledge a scheduled wake-up but not a subagent', () => {
      const { tracker, agentStates } = createTracker();
      const wakeup: BackgroundWork = { id: 'cron:check', kind: 'wakeup' };

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([wakeup]));
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([wakeup]));

      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');
    });

    it('logs each stop decision with ids by kind and never the reply text', () => {
      const warn = vi.fn();
      const { tracker } = createTracker({ ...noopLogger, warn });

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server'), agent('review')]));

      expect(warn).toHaveBeenCalledWith(
        'TuiAgentStates: turn opened with background work in flight',
        {
          conversationId: 'conv-1',
          providerId: 'claude',
          initiator: 'user',
          awaited: [],
          acknowledged: ['task:dev-server'],
        }
      );
      expect(warn).toHaveBeenLastCalledWith('TuiAgentStates: stop applied', {
        conversationId: 'conv-1',
        providerId: 'claude',
        agents: ['task:review'],
        processes: ['task:dev-server'],
        wakeups: [],
        awaited: ['task:review'],
        acknowledged: ['task:dev-server'],
        status: 'working',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('report');
    });

    it('logs a stop that reports no background work too', () => {
      const warn = vi.fn();
      const { tracker } = createTracker({ ...noopLogger, warn });

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop());

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('TuiAgentStates: stop applied', {
        conversationId: 'conv-1',
        providerId: 'claude',
        agents: [],
        processes: [],
        wakeups: [],
        awaited: [],
        acknowledged: [],
        status: 'completed',
      });
    });

    it('counts the awaited subagents, through any turn, until the last reports back', () => {
      const { tracker, agentStates } = createTracker();
      const count = () => peek(agentStates.states.list)['conv-1']?.backgroundAgents;

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      expect(count()).toBeUndefined();
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([agent('a1'), agent('a2'), shell('b')]));
      expect(count()).toBe(2);

      // Neither a user follow-up nor a wake-up releases a subagent.
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      expect(count()).toBe(2);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([agent('a1'), agent('a2'), shell('b')]));
      expect(count()).toBe(2);
      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      expect(count()).toBe(2);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([agent('a1'), shell('b')]));
      expect(count()).toBe(1);

      // A permission prompt replaces the state; the next stop reports the count again.
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'permission_prompt',
      });
      expect(count()).toBeUndefined();

      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('b')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');
      expect(count()).toBeUndefined();
    });

    it('reports no subagent count for a wait on shells alone', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('build')]));

      const state = peek(agentStates.states.list)['conv-1'];
      expect(state).toMatchObject({ status: 'working', awaitingBackgroundWork: true });
      expect(state?.backgroundAgents).toBeUndefined();
    });

    it('forgets tracked background work when the session is cleared', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.clear('conv-1');

      // A fresh session reusing the id must not inherit the old acknowledgement.
      tracker.applyCanonicalEvent('conv-1', 'claude', stop([shell('dev-server')]));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
    });
  });

  describe('sub-agents', () => {
    const hooked = {
      hooks: { kind: 'config', scope: 'global', supportedEvents: ['start'] },
    } as never;
    const start = { kind: 'status', type: 'start' } as const;
    const subStart = (agentId: string, agentType?: string) =>
      ({
        kind: 'subagent',
        type: 'start',
        subAgent: agentType ? { agentId, agentType } : { agentId },
      }) as const;
    const subStop = (agentId: string, running?: { agentId: string; description?: string }[]) =>
      ({ kind: 'subagent', type: 'stop', subAgent: { agentId }, running }) as const;

    function setup() {
      vi.useFakeTimers();
      let time = 1_000;
      const created = createTracker(undefined, () => time);
      const state = () => peek(created.agentStates.states.list)['conv-1'];
      const labels = () => state()?.subAgents?.map((agent) => agent.label);
      const flush = () => vi.advanceTimersByTime(SUB_AGENT_PUBLISH_DELAY_MS);
      return { ...created, state, labels, flush, advance: (ms: number) => (time += ms) };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('lists a foreground sub-agent while it runs within a turn, without touching the status', () => {
      const { tracker, state, labels, flush, onAgentStateChanged } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      const working = state();
      onAgentStateChanged.mockClear();

      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      flush();
      expect(labels()).toEqual(['Explore']);
      expect(state()).toMatchObject({ status: 'working', updatedAt: working?.updatedAt });

      tracker.applyCanonicalEvent('conv-1', 'claude', subStop('a1'));
      flush();
      expect(state()?.subAgents).toBeUndefined();
      expect(state()).toEqual(working);
      // Sub-agent changes are the same turn going on: nothing is saved for them.
      expect(onAgentStateChanged).not.toHaveBeenCalled();
    });

    it('publishes a burst of starts as one update', () => {
      const { tracker, agentStates, labels, flush } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      const writes = vi.spyOn(agentStates.states.list, 'set');

      for (const id of ['a1', 'a2', 'a3', 'a4']) {
        tracker.applyCanonicalEvent('conv-1', 'claude', subStart(id, 'Explore'));
      }
      expect(labels()).toBeUndefined();
      flush();

      expect(labels()).toEqual(['Explore', 'Explore', 'Explore', 'Explore']);
      expect(writes).toHaveBeenCalledTimes(1);
    });

    it('carries the latest sub-agents at once on a status change', () => {
      const { tracker, state } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType: 'permission_prompt',
      });

      expect(state()).toMatchObject({
        status: 'awaiting-input',
        subAgents: [{ id: 'a1', label: 'Explore' }],
      });
    });

    it('keeps the background sub-agents at the end of a turn, labelled by their task', () => {
      const { tracker, state } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('fg', 'Explore'));
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('bg', 'general-purpose'));
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'stop',
        backgroundWork: [{ id: 'task:bg', kind: 'agent' }],
        subAgents: [{ agentId: 'bg', agentType: 'general-purpose', description: 'Run the tests' }],
      });

      expect(state()).toMatchObject({ status: 'working', backgroundAgents: 1 });
      expect(state()?.subAgents).toEqual([
        { id: 'bg', label: 'Run the tests', agentType: 'general-purpose', startedAt: 1_000 },
      ]);
    });

    it('clears foreground sub-agents when a turn ends without reporting them', () => {
      const { tracker, state } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      tracker.applyCanonicalEvent('conv-1', 'claude', { kind: 'status', type: 'stop' });

      expect(state()?.status).toBe('completed');
      expect(state()?.subAgents).toBeUndefined();
    });

    it('drops foreground sub-agents when the turn is interrupted, and keeps background ones', () => {
      const { tracker, labels, flush } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('bg', 'general-purpose'));
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('fg', 'Explore'));
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('done', 'Plan'));
      tracker.applyCanonicalEvent(
        'conv-1',
        'claude',
        subStop('done', [{ agentId: 'bg', description: 'Watch the build' }])
      );
      flush();
      expect(labels()).toEqual(['Watch the build', 'Explore']);

      tracker.markInputSubmitted('conv-1', hooked, '\x1b');
      flush();
      expect(labels()).toEqual(['Watch the build']);
    });

    it('treats Ctrl+C as an interrupt but not ordinary keys or escape sequences', () => {
      const { tracker, labels, flush } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      flush();

      tracker.markInputSubmitted('conv-1', hooked, '\x1b[A');
      tracker.markInputSubmitted('conv-1', hooked, 'q');
      flush();
      expect(labels()).toEqual(['Explore']);

      tracker.markInputSubmitted('conv-1', hooked, '\x03');
      flush();
      expect(labels()).toBeUndefined();
    });

    it('drops the foreground sub-agents of a turn that ends in an error', () => {
      const { tracker, state } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      tracker.applyCanonicalEvent('conv-1', 'claude', { kind: 'status', type: 'error' });

      expect(state()).toMatchObject({ status: 'error' });
      expect(state()?.subAgents).toBeUndefined();
    });

    it('forgets every sub-agent when the session ends or is cleared', () => {
      const { tracker, state, flush } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      tracker.resetToIdle('conv-1');
      flush();
      expect(state()).toMatchObject({ status: 'idle' });
      expect(state()?.subAgents).toBeUndefined();

      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a2', 'Explore'));
      tracker.clear('conv-1');
      flush();
      expect(state()).toBeUndefined();
    });

    it('does not restore sub-agents saved before a restart', () => {
      const { tracker, state } = setup();
      tracker.restore({
        conversationId: 'conv-1',
        status: 'working',
        subAgents: [{ id: 'a1', label: 'Explore', startedAt: 1 }],
        updatedAt: 1,
      });
      expect(state()).toEqual({ conversationId: 'conv-1', status: 'working', updatedAt: 1 });
    });

    it('reads a sub-agent heard before any prompt as the agent working', () => {
      const { tracker, state, flush } = setup();
      tracker.applyCanonicalEvent('conv-1', 'claude', subStart('a1', 'Explore'));
      flush();
      expect(state()).toMatchObject({
        status: 'working',
        subAgents: [{ id: 'a1', label: 'Explore' }],
      });
    });
  });

  it('marks input submitted as working only when the provider lacks a start hook', () => {
    const { tracker, agentStates } = createTracker();

    tracker.markInputSubmitted('conv-1', { hooks: { kind: 'none' } }, '\r');
    expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

    tracker.markInputSubmitted(
      'conv-2',
      { hooks: { kind: 'config', scope: 'workspace', supportedEvents: ['start'] } },
      '\r'
    );
    expect(peek(agentStates.states.list)['conv-2']).toBeUndefined();
  });

  it('publishes valid provider session ids through the sessions model', () => {
    const { tracker, sessions, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'amp',
        sessionId: null,
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'amp', {
      kind: 'session',
      providerSessionId: 'T-123',
    });

    expect(peek(sessions.states.list)['conv-1']?.sessionId).toBe('T-123');
    expect(onSessionIdChanged).toHaveBeenCalledWith('conv-1', 'T-123');
  });

  it('adopts a provider session id carried on a status event', () => {
    const { tracker, sessions, agentStates, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'claude',
        sessionId: 'conv-1',
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'start',
      providerSessionId: 'resumed-session',
    });

    expect(peek(sessions.states.list)['conv-1']?.sessionId).toBe('resumed-session');
    expect(onSessionIdChanged).toHaveBeenCalledWith('conv-1', 'resumed-session');
    expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
  });

  it('does not re-publish an unchanged session id carried on status events', () => {
    const { tracker, sessions, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'claude',
        sessionId: 'conv-1',
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'start',
      providerSessionId: 'conv-1',
    });
    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'stop',
      providerSessionId: 'conv-1',
    });

    expect(onSessionIdChanged).not.toHaveBeenCalled();
  });
});
