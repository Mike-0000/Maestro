import { peek } from '@emdash/wire/state';
import { describe, expect, it, vi } from 'vitest';
import {
  createTuiAgentStatesLiveModel,
  createTuiAgentStatesListModel,
  createTuiSessionsLiveModel,
  createTuiSessionsListModel,
  produceCell,
} from '#runtimes/tui-agents/node/state/live-models';
import { TuiAgentStates } from './agent-state';

function createTracker() {
  const sessionsLiveModel = createTuiSessionsLiveModel();
  const agentStatesLiveModel = createTuiAgentStatesLiveModel();
  const sessions = createTuiSessionsListModel(sessionsLiveModel);
  const agentStates = createTuiAgentStatesListModel(agentStatesLiveModel);
  const onSessionIdChanged = vi.fn();
  const onAgentStateChanged = vi.fn();
  const tracker = new TuiAgentStates(
    sessions,
    agentStates,
    () => 1_000,
    onSessionIdChanged,
    onAgentStateChanged
  );
  return { tracker, sessions, agentStates, onSessionIdChanged, onAgentStateChanged };
}

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
    const stop = (backgroundWork?: string[]) =>
      ({ kind: 'status', type: 'stop', backgroundWork, lastAssistantMessage: 'report' }) as const;
    const statuses = (onAgentStateChanged: ReturnType<typeof vi.fn>) =>
      onAgentStateChanged.mock.calls.map(([, state]) => state.status);

    it('keeps the agent working when its turn ends waiting on a background shell', () => {
      const { tracker, agentStates, onAgentStateChanged } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:build']));

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
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:build', 'task:publish']));
      tracker.applyCanonicalEvent('conv-1', 'claude', wakeUp);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:publish']));

      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });
    });

    it('surfaces a permission prompt raised while waiting on background work', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:build']));
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
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:build']));
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
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:dev-server']));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:dev-server']));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('completed');

      // Work launched by the later turn holds completion again.
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:dev-server', 'task:tests']));
      expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
        status: 'working',
        awaitingBackgroundWork: true,
      });
    });

    it('forgets tracked background work when the session is cleared', () => {
      const { tracker, agentStates } = createTracker();

      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:dev-server']));
      tracker.applyCanonicalEvent('conv-1', 'claude', start);
      tracker.clear('conv-1');

      // A fresh session reusing the id must not inherit the old acknowledgement.
      tracker.applyCanonicalEvent('conv-1', 'claude', stop(['task:dev-server']));
      expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
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
