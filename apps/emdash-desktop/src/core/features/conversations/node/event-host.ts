import { createEventStreamHost } from '@emdash/wire/live';
import type { ConversationEvent } from '@core/primitives/conversations/api';
import { conversationsContract } from '../api';

export const conversationWireEvents = createEventStreamHost(conversationsContract.events);

export function conversationEventKey(event: ConversationEvent): { taskId: string } | undefined {
  if (event.type === 'created') {
    const taskId = event.conversation.taskId;
    return taskId ? { taskId } : undefined;
  }
  return event.taskId ? { taskId: event.taskId } : undefined;
}

export function emitConversationWireEvent(event: ConversationEvent): void {
  const key = conversationEventKey(event);
  if (!key) return;
  conversationWireEvents.emit(key, event);
}
