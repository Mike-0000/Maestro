import type { AutomationAgentConfig, AutomationRun } from '@emdash/core/runtimes/automations/api';
import { describe, expect, it } from 'vitest';
import { conversationForRun } from './adoption-builder';

function runWithAgent(agent: AutomationAgentConfig): AutomationRun {
  return {
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    configSnapshot: { name: 'Review changes', agent },
  } as unknown as AutomationRun;
}

describe('conversationForRun', () => {
  it('carries the ACP effort into the adopted conversation config', () => {
    const conversation = conversationForRun(
      runWithAgent({
        type: 'acp',
        start: {
          providerId: 'claude',
          model: 'sonnet',
          effort: 'high',
          modeId: 'bypassPermissions',
          initialQueue: [{ text: 'Review' }],
        },
      }),
      'project-1',
      'task-1'
    );

    expect(conversation?.config).toStrictEqual({
      version: '1',
      type: 'acp',
      model: 'sonnet',
      modeId: 'bypassPermissions',
      effort: 'high',
      initialQueue: [{ text: 'Review' }],
    });
  });

  it('leaves effort out when the run has none', () => {
    const conversation = conversationForRun(
      runWithAgent({
        type: 'acp',
        start: { providerId: 'claude', model: null, initialQueue: [{ text: 'Review' }] },
      }),
      'project-1',
      'task-1'
    );

    expect(conversation?.config).toStrictEqual({
      version: '1',
      type: 'acp',
      initialQueue: [{ text: 'Review' }],
    });
  });
});
