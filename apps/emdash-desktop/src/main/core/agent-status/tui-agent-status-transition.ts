import type { TuiAgentState, TuiSubAgent } from '@emdash/core/runtimes/tui-agents/api';
import { redactSecrets } from '@emdash/shared/logger';
import type { AgentStatusSignal, RunningSubAgent } from '@core/primitives/agents/api';

/** At most this many sub-agents leave the main process for one conversation. */
export const MAX_PUBLISHED_SUB_AGENTS = 32;
const SUB_AGENT_LABEL_MAX_CHARS = 80;
const SUB_AGENT_TYPE_MAX_CHARS = 40;
/** Longer text is cut before redaction runs, so a pathological label stays cheap. */
const MAX_LABEL_INPUT_CHARS = 2_000;

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

/**
 * True when only the running sub-agents changed (one started or stopped within the turn): the
 * same turn going on, republished like a change of the subagent count, never a transition.
 */
export function isSubAgentsOnlyChange(
  previous: TuiAgentState | undefined,
  next: TuiAgentState
): boolean {
  return (
    previous !== undefined &&
    previous.status === next.status &&
    previous.notificationType === next.notificationType &&
    previous.backgroundAgents === next.backgroundAgents &&
    !sameSubAgents(previous.subAgents, next.subAgents)
  );
}

export function eventFromTuiAgentState(state: TuiAgentState): AgentStatusSignal | null {
  const subAgents = publishableSubAgents(state.subAgents);
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
      ...(subAgents ? { subAgents } : {}),
    },
  } satisfies Omit<AgentStatusSignal, 'type'>;

  if (state.status === 'working') return { ...base, type: 'start' };
  if (state.status === 'completed') return { ...base, type: 'stop' };
  if (state.status === 'error') return { ...base, type: 'error' };
  if (state.status === 'awaiting-input') return { ...base, type: 'notification' };
  return null;
}

/**
 * The sub-agents a host reported, fit to leave the main process: bounded in number and length
 * and redacted again, since a host may run a runtime that did not. Undefined for none.
 */
export function publishableSubAgents(
  subAgents: readonly TuiSubAgent[] | undefined
): RunningSubAgent[] | undefined {
  if (!subAgents?.length) return undefined;
  const published: RunningSubAgent[] = [];
  for (const subAgent of subAgents.slice(0, MAX_PUBLISHED_SUB_AGENTS)) {
    const agentType = boundedText(subAgent.agentType, SUB_AGENT_TYPE_MAX_CHARS);
    const label = boundedText(subAgent.label, SUB_AGENT_LABEL_MAX_CHARS) ?? agentType;
    if (!subAgent.id || !label) continue;
    published.push({
      id: subAgent.id,
      label,
      ...(agentType ? { agentType } : {}),
      startedAt: subAgent.startedAt,
    });
  }
  return published.length > 0 ? published : undefined;
}

function boundedText(text: string | undefined, maxChars: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = redactSecrets(text.slice(0, MAX_LABEL_INPUT_CHARS))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  if (clean.length <= maxChars) return clean;
  // Cut by UTF-16 unit, never through the middle of a surrogate pair.
  return `${clean
    .slice(0, maxChars - 1)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()}…`;
}

function sameSubAgents(
  a: readonly TuiSubAgent[] | undefined,
  b: readonly TuiSubAgent[] | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((item, index) => item.id === right[index]?.id && item.label === right[index]?.label)
  );
}
