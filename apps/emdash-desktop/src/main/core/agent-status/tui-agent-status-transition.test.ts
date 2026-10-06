import type { TuiAgentState } from '@emdash/core/runtimes/tui-agents/api';
import { describe, expect, it } from 'vitest';
import {
  eventFromTuiAgentState,
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
});
