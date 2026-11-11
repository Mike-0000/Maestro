import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationEvent } from '@core/primitives/conversations/api';
import { ConversationStore } from './conversation-manager';

type StatusEvent = Extract<ConversationEvent, { type: 'agent-status-changed' }>;

function store(): ConversationStore {
  return new ConversationStore({
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'claude',
    title: 'Chat',
    lastInteractedAt: null,
    isInitialConversation: false,
    agentStatus: 'idle',
  } as Conversation);
}

function event(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    type: 'agent-status-changed',
    conversationId: 'conversation-1',
    taskId: 'task-1',
    projectId: 'project-1',
    status: 'working',
    seen: true,
    ...overrides,
  };
}

const explore = { id: 'a1', label: 'Explore', agentType: 'Explore', startedAt: 5 };
const review = { id: 'a2', label: 'Review the diff', startedAt: 9 };

describe('ConversationStore.applyAgentStatusChanged', () => {
  it('keeps the running sub-agents a working agent reports, with their labels', () => {
    const conversation = store();
    conversation.applyAgentStatusChanged(event({ subAgents: [explore, review] }));
    expect(conversation.subAgents).toEqual([explore, review]);

    conversation.applyAgentStatusChanged(event({ subAgents: [review] }));
    expect(conversation.subAgents).toEqual([review]);

    conversation.applyAgentStatusChanged(event());
    expect(conversation.subAgents).toEqual([]);
  });

  it('keeps the same array while what it shows is unchanged', () => {
    const conversation = store();
    conversation.applyAgentStatusChanged(event({ subAgents: [explore] }));
    const first = conversation.subAgents;
    conversation.applyAgentStatusChanged(event({ subAgents: [{ ...explore }] }));
    expect(conversation.subAgents).toBe(first);
  });

  it('keeps sub-agents through a prompt mid-turn and drops them when the turn ends', () => {
    const conversation = store();
    conversation.applyAgentStatusChanged(
      event({ status: 'awaiting-input', seen: false, subAgents: [explore] })
    );
    expect(conversation.subAgents).toEqual([explore]);

    conversation.applyAgentStatusChanged(event({ status: 'completed', subAgents: [explore] }));
    expect(conversation.subAgents).toEqual([]);
  });

  it('leaves the subagent count as it was for a host that names no sub-agents', () => {
    const conversation = store();
    conversation.applyAgentStatusChanged(event({ backgroundAgents: 3 }));
    expect(conversation.backgroundAgents).toBe(3);
    expect(conversation.subAgents).toEqual([]);

    conversation.applyAgentStatusChanged(event({ backgroundAgents: 2, subAgents: [explore] }));
    expect(conversation.backgroundAgents).toBe(2);
    expect(conversation.subAgents).toEqual([explore]);

    conversation.applyAgentStatusChanged(event({ status: 'completed' }));
    expect(conversation.backgroundAgents).toBeNull();
  });

  it('drops sub-agents when the agent is set idle locally', () => {
    const conversation = store();
    conversation.applyAgentStatusChanged(event({ subAgents: [explore] }));
    conversation.clearWorking();
    expect(conversation.subAgents).toEqual([]);
  });
});
