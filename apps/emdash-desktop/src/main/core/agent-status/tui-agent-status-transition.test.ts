import type { TuiAgentState } from '@emdash/core/runtimes/tui-agents/api';
import { describe, expect, it } from 'vitest';
import {
  eventFromTuiAgentState,
  isBackgroundAgentsOnlyChange,
  isSubAgentsOnlyChange,
  MAX_PUBLISHED_SUB_AGENTS,
  publishableSubAgents,
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

  describe('running sub-agents', () => {
    const explore = { id: 'a1', label: 'Explore', agentType: 'Explore', startedAt: 10 };
    const review = { id: 'a2', label: 'Review the diff', startedAt: 20 };

    it('treats a sub-agent starting or stopping as the same turn, never a transition', () => {
      const before = state();
      const after = state({ subAgents: [explore] });

      expect(shouldApplyAgentStateTransition(before, after)).toBe(false);
      expect(isBackgroundAgentsOnlyChange(before, after)).toBe(false);
      expect(isSubAgentsOnlyChange(before, after)).toBe(true);
      expect(isSubAgentsOnlyChange(after, state({ subAgents: [explore, review] }))).toBe(true);
      expect(isSubAgentsOnlyChange(after, before)).toBe(true);
      expect(isSubAgentsOnlyChange(after, state({ subAgents: [{ ...explore }] }))).toBe(false);
      expect(isSubAgentsOnlyChange(undefined, after)).toBe(false);
      // A status change carries the sub-agents itself.
      expect(isSubAgentsOnlyChange(after, state({ status: 'completed' }))).toBe(false);
    });

    it('carries the running sub-agents on the signal', () => {
      expect(eventFromTuiAgentState(state({ subAgents: [explore, review] }))).toMatchObject({
        type: 'start',
        payload: { subAgents: [explore, review] },
      });
      expect(eventFromTuiAgentState(state())?.payload).not.toHaveProperty('subAgents');
    });

    it('bounds and redacts what a host reports before it leaves the main process', () => {
      const many = Array.from({ length: MAX_PUBLISHED_SUB_AGENTS + 3 }, (_, index) => ({
        id: `a${index}`,
        label: 'x'.repeat(300),
        startedAt: index,
      }));
      const published = publishableSubAgents(many)!;
      expect(published).toHaveLength(MAX_PUBLISHED_SUB_AGENTS);
      expect(published[0]!.label.length).toBeLessThanOrEqual(80);

      const [secret] = publishableSubAgents([
        { id: 'a1', label: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789\nnow', startedAt: 1 },
      ])!;
      expect(secret!.label).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(secret!.label).not.toContain('\n');
    });

    it('labels a sub-agent with a blank label by its type, and drops one with neither', () => {
      expect(
        publishableSubAgents([
          { id: 'a1', label: ' ', agentType: 'Plan', startedAt: 1 },
          { id: 'a2', label: '', startedAt: 2 },
        ])
      ).toEqual([{ id: 'a1', label: 'Plan', agentType: 'Plan', startedAt: 1 }]);
      expect(publishableSubAgents([])).toBeUndefined();
      expect(publishableSubAgents(undefined)).toBeUndefined();
    });
  });
});
