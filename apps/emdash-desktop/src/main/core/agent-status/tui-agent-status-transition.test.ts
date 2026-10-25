import type { TuiAgentState } from '@emdash/core/runtimes/tui-agents/api';
import { describe, expect, it } from 'vitest';
import {
  eventFromTuiAgentState,
  isBackgroundAgentsOnlyChange,
  shouldApplyAgentStateTransition,
} from './tui-agent-status-transition';

function state(overrides: Partial<TuiAgentState> = {}): TuiAgentState {
  return {
    conversationId: 'conv-1',
    providerId: 'codex',
    status: 'working',
    source: 'hook',
    updatedAt: 123,
    ...overrides,
  };
}

describe('TUI agent status transition mapping', () => {
  it('maps working agent state to a context-free start signal', () => {
    expect(eventFromTuiAgentState(state())).toMatchObject({
      type: 'start',
      source: 'hook',
      providerId: 'codex',
      conversationId: 'conv-1',
      timestamp: 123,
    });
  });

  it('maps awaiting input to a notification event', () => {
    expect(
      eventFromTuiAgentState(
        state({
          status: 'awaiting-input',
          notificationType: 'permission_prompt',
          message: 'Approve?',
        })
      )
    ).toMatchObject({
      type: 'notification',
      payload: {
        notificationType: 'permission_prompt',
        message: 'Approve?',
      },
    });
  });

  it('does not project idle as an AgentEvent', () => {
    expect(eventFromTuiAgentState(state({ status: 'idle' }))).toBeNull();
  });

  it('suppresses duplicate status and notification-type updates', () => {
    expect(
      shouldApplyAgentStateTransition(
        state({ status: 'awaiting-input', notificationType: 'permission_prompt' }),
        state({ status: 'awaiting-input', notificationType: 'permission_prompt' })
      )
    ).toBe(false);
    expect(
      shouldApplyAgentStateTransition(state({ status: 'working' }), state({ status: 'completed' }))
    ).toBe(true);
  });

  it('does not report completion while the agent waits on background work', () => {
    const waiting = state({
      status: 'working',
      awaitingBackgroundWork: true,
      lastAssistantMessage: 'The push is running in the background.',
    });

    expect(shouldApplyAgentStateTransition(state({ status: 'working' }), waiting)).toBe(false);
    expect(eventFromTuiAgentState(waiting)).toMatchObject({ type: 'start' });
  });

  it('publishes each change in the awaited subagent count while the agent stays working', () => {
    const waiting = (backgroundAgents?: number) =>
      state({ status: 'working', awaitingBackgroundWork: true, backgroundAgents });

    expect(shouldApplyAgentStateTransition(state(), waiting(7))).toBe(true);
    expect(shouldApplyAgentStateTransition(waiting(7), waiting(6))).toBe(true);
    expect(shouldApplyAgentStateTransition(waiting(6), waiting(6))).toBe(false);
    expect(isBackgroundAgentsOnlyChange(waiting(7), waiting(6))).toBe(true);
    expect(isBackgroundAgentsOnlyChange(undefined, waiting(6))).toBe(false);
    // Finishing is a real transition, not a count update.
    expect(isBackgroundAgentsOnlyChange(waiting(1), state({ status: 'completed' }))).toBe(false);
    expect(eventFromTuiAgentState(waiting(6))).toMatchObject({
      type: 'start',
      payload: { backgroundAgents: 6 },
    });
  });
});
