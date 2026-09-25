import { describe, expect, it } from 'vitest';
import { conversationEventKey } from './event-host';

describe('conversationEventKey', () => {
  it('keys created events by the conversation task', () => {
    expect(
      conversationEventKey({
        type: 'created',
        conversation: {
          id: 'c1',
          projectId: 'p1',
          taskId: 'task-9',
          providerId: 'codex',
          title: 'Atlas',
          lastInteractedAt: null,
          isInitialConversation: false,
        },
      })
    ).toEqual({ taskId: 'task-9' });
  });

  it('keys status and membership events by taskId', () => {
    expect(
      conversationEventKey({
        type: 'deleted',
        conversationId: 'c1',
        projectId: 'p1',
        taskId: 'task-2',
      })
    ).toEqual({ taskId: 'task-2' });
  });
});
