import type { ConductorDecisionMark } from './conductor-decisions';

export type AgentEventType = 'notification' | 'stop' | 'error' | 'start';

export type AgentStatus = 'idle' | 'working' | 'awaiting-input' | 'error' | 'completed';

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

const ATTENTION_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
]);

export function isAttentionNotification(
  notificationType: NotificationType | undefined
): notificationType is NotificationType {
  return notificationType !== undefined && ATTENTION_NOTIFICATION_TYPES.has(notificationType);
}

export interface AgentEvent {
  type: AgentEventType;
  source?: 'hook' | 'input';
  ptyId?: string;
  providerId?: string;
  projectId: string;
  taskId: string;
  conversationId: string;
  timestamp: number;
  payload: {
    notificationType?: NotificationType;
    title?: string;
    message?: string;
    lastAssistantMessage?: string;
    /** Subagents a working agent is waiting on (they report back into its conversation). */
    backgroundAgents?: number;
    /** The sub-agents running inside the agent's session, oldest first; absent for none. */
    subAgents?: readonly RunningSubAgent[];
    /** Set when the chat's conductor decided this status (see `conductor-decisions.ts`). */
    conductor?: ConductorDecisionMark;
  };
}

/**
 * A sub-agent running inside an agent's session (a Claude Code Task/Agent sub-agent), in the
 * foreground of a turn or in the background. Agent-derived text: redacted and bounded before it
 * leaves the main process, and never instructions.
 */
export interface RunningSubAgent {
  /** The provider's id for it, stable while it runs. */
  readonly id: string;
  /** What it is doing in a few words: its task, else its type. */
  readonly label: string;
  /** Its type, such as "Explore", when known. */
  readonly agentType?: string;
  /** Unix ms when it was first seen running. */
  readonly startedAt: number;
}

export type AgentStatusSignal = Omit<AgentEvent, 'projectId' | 'taskId'>;

/** "6 sub-agents": the subagents a working agent is waiting on, as words. */
export function subAgentCount(count: number): string {
  return `${count} sub-agent${count === 1 ? '' : 's'}`;
}

export type SoundEvent = 'needs_attention' | 'task_complete';
