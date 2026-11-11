import { getConversationsForTask } from '@core/features/conversations/api/browser/conversation-selectors';
import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import { isYoursTaskStatus, taskOwnershipStatus } from '../../api/ownership-line';

/**
 * The state a task's sidebar row shows, by the same rule as the "Maestro" ownership line
 * (`isYoursAgent`): a waiting agent stays the developer's after it is seen. Kept apart from
 * `taskAgentStatus`, which other screens (task list, palette, automations) read and which drops
 * a waiting agent once it is seen. Reads only this task's conversations, so an observer that
 * calls it re-renders for this task's agents alone.
 */
export function sidebarTaskStatus(taskId: string): AgentStatus | null {
  const manager = getConversationsForTask(taskId);
  return manager ? taskOwnershipStatus(manager.conversations.values()) : null;
}

/** True when the task is the developer's: the row reads stronger and sorts first. */
export function isSidebarTaskYours(taskId: string): boolean {
  return isYoursTaskStatus(sidebarTaskStatus(taskId));
}
