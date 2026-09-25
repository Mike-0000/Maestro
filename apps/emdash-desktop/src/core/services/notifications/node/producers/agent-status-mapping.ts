import { isAttentionNotification, type AgentEvent } from '@core/primitives/agents/api';
import {
  completionNotificationBody,
  summarizeCompletionMessage,
} from '@core/primitives/agents/api/completion-summary';
import type { PublishNotification } from '../../api';

export function agentNotificationInputFromEvent(
  event: AgentEvent,
  providerName: string,
  taskName: string | null,
  mapping = notificationMapping(event)
): PublishNotification {
  if (!mapping) {
    throw new Error(`Agent event '${event.type}' does not map to a notification`);
  }

  return {
    kind: mapping.kind,
    groupKey: `conversation:${event.conversationId}`,
    dedupeKey: `${event.conversationId}:${event.type}:${event.timestamp}`,
    title: taskName ? `${providerName} - ${taskName}` : providerName,
    body: mapping.body,
    sound: mapping.sound,
    target: {
      kind: 'task',
      projectId: event.projectId,
      taskId: event.taskId,
      conversationId: event.conversationId,
    },
    source: {
      kind: 'conversation',
      projectId: event.projectId,
      taskId: event.taskId,
      conversationId: event.conversationId,
    },
  };
}

export function notificationMapping(event: AgentEvent): {
  kind: 'agent-attention' | 'agent-complete';
  body: string;
  sound: 'needs_attention' | 'task_complete';
} | null {
  if (event.type === 'stop') {
    // Say what finished when the agent's final reply allows it; otherwise the generic body.
    const summary = summarizeCompletionMessage(event.payload.lastAssistantMessage);
    return {
      kind: 'agent-complete',
      body: completionNotificationBody(summary) ?? 'Your agent has finished working',
      sound: 'task_complete',
    };
  }

  if (event.type === 'notification' && isAttentionNotification(event.payload.notificationType)) {
    return {
      kind: 'agent-attention',
      body: 'Your agent is waiting for input',
      sound: 'needs_attention',
    };
  }

  return null;
}
