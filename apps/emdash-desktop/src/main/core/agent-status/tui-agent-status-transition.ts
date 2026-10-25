import type { TuiAgentState } from '@emdash/core/runtimes/tui-agents/api';
import type { AgentStatusSignal } from '@core/primitives/agents/api';

export function shouldApplyAgentStateTransition(
  previous: TuiAgentState | undefined,
  next: TuiAgentState
): boolean {
  if (!previous) return true;
  if (previous.status !== next.status) return true;
  if (previous.notificationType !== next.notificationType) return true;
  // 7 → 6 → 5 subagents left: the agent stays working, but what it is doing changed.
  if (previous.backgroundAgents !== next.backgroundAgents) return true;
  return false;
}

/** True when only the subagent count moved: the same turn, not a new one. */
export function isBackgroundAgentsOnlyChange(
  previous: TuiAgentState | undefined,
  next: TuiAgentState
): boolean {
  return (
    previous !== undefined &&
    previous.status === next.status &&
    previous.notificationType === next.notificationType &&
    previous.backgroundAgents !== next.backgroundAgents
  );
}

export function eventFromTuiAgentState(state: TuiAgentState): AgentStatusSignal | null {
  const base = {
    source: state.source,
    providerId: state.providerId,
    conversationId: state.conversationId,
    timestamp: state.updatedAt,
    payload: {
      notificationType: state.notificationType,
      title: state.title,
      message: state.message,
      lastAssistantMessage: state.lastAssistantMessage,
      backgroundAgents: state.backgroundAgents,
    },
  } satisfies Omit<AgentStatusSignal, 'type'>;

  if (state.status === 'working') return { ...base, type: 'start' };
  if (state.status === 'completed') return { ...base, type: 'stop' };
  if (state.status === 'error') return { ...base, type: 'error' };
  if (state.status === 'awaiting-input') return { ...base, type: 'notification' };
  return null;
}
