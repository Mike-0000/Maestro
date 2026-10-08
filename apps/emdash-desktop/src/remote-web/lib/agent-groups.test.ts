import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { describe, expect, it } from 'vitest';
import {
  agentGroupOf,
  agentPreview,
  countNeedingAttention,
  filterAgents,
  groupAgents,
  mostRecentProjectId,
} from './agent-groups';

function agent(overrides: Partial<RemoteAgent> & { conversationId: string }): RemoteAgent {
  return {
    taskId: `task-${overrides.conversationId}`,
    projectId: 'p1',
    taskName: overrides.conversationId,
    title: 'Claude Code',
    providerId: 'claude',
    kind: 'terminal',
    status: 'idle',
    running: true,
    needsAttention: false,
    lastActivityAt: null,
    archived: false,
    ...overrides,
  };
}

describe('agentGroupOf', () => {
  it('puts anything blocked on a person first, whatever its status says', () => {
    expect(
      agentGroupOf(agent({ conversationId: 'a', needsAttention: true, status: 'working' }))
    ).toBe('attention');
    expect(agentGroupOf(agent({ conversationId: 'b', status: 'awaiting-input' }))).toBe(
      'attention'
    );
  });

  it('separates working agents from the rest', () => {
    expect(agentGroupOf(agent({ conversationId: 'a', status: 'working' }))).toBe('working');
    for (const status of ['idle', 'completed', 'error', 'unknown'] as const) {
      expect(agentGroupOf(agent({ conversationId: 'a', status }))).toBe('idle');
    }
  });
});

describe('groupAgents', () => {
  it('orders groups by how actionable they are and drops empty ones', () => {
    const groups = groupAgents([
      agent({ conversationId: 'idle' }),
      agent({ conversationId: 'ask', needsAttention: true }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['attention', 'idle']);
    expect(groups.map((group) => group.label)).toEqual(['Needs you', 'Idle']);
  });

  it('sorts each group by most recent activity, then name', () => {
    const [group] = groupAgents([
      agent({ conversationId: 'never-b', taskName: 'b' }),
      agent({ conversationId: 'old', lastActivityAt: 100 }),
      agent({ conversationId: 'never-a', taskName: 'a' }),
      agent({ conversationId: 'new', lastActivityAt: 900 }),
    ]);
    expect(group?.agents.map((entry) => entry.conversationId)).toEqual([
      'new',
      'old',
      'never-a',
      'never-b',
    ]);
  });
});

describe('filterAgents', () => {
  const agents = [
    agent({ conversationId: 'a', projectId: 'p1' }),
    agent({ conversationId: 'b', projectId: 'p2' }),
    agent({ conversationId: 'c', projectId: 'p1', archived: true }),
  ];

  it('hides archived agents unless asked', () => {
    const ids = (showArchived: boolean): string[] =>
      filterAgents(agents, { projectId: null, showArchived }).map((entry) => entry.conversationId);
    expect(ids(false)).toEqual(['a', 'b']);
    expect(ids(true)).toEqual(['a', 'b', 'c']);
  });

  it('narrows to one project', () => {
    expect(
      filterAgents(agents, { projectId: 'p1', showArchived: true }).map(
        (entry) => entry.conversationId
      )
    ).toEqual(['a', 'c']);
  });
});

describe('countNeedingAttention', () => {
  it('ignores archived agents', () => {
    expect(
      countNeedingAttention([
        agent({ conversationId: 'a', needsAttention: true }),
        agent({ conversationId: 'b', status: 'awaiting-input' }),
        agent({ conversationId: 'c', needsAttention: true, archived: true }),
        agent({ conversationId: 'd', status: 'working' }),
      ])
    ).toBe(2);
  });
});

describe('agentPreview', () => {
  it('shows the question when the agent is waiting, else its last message', () => {
    expect(
      agentPreview(
        agent({
          conversationId: 'a',
          needsAttention: true,
          message: 'Allow  Bash?\n',
          lastAssistantMessage: 'Running the tests.',
        })
      )
    ).toBe('Allow Bash?');
    expect(
      agentPreview(
        agent({ conversationId: 'a', message: 'stale', lastAssistantMessage: 'All done.' })
      )
    ).toBe('All done.');
    expect(agentPreview(agent({ conversationId: 'a' }))).toBe('');
  });
});

describe('mostRecentProjectId', () => {
  it('prefers the project an agent was last active in', () => {
    const agents = [
      agent({ conversationId: 'a', projectId: 'p1', lastActivityAt: 10 }),
      agent({ conversationId: 'b', projectId: 'p2', lastActivityAt: 50 }),
      agent({ conversationId: 'c', projectId: 'gone', lastActivityAt: 99 }),
    ];
    expect(mostRecentProjectId(agents, ['p1', 'p2'])).toBe('p2');
  });

  it('falls back to the first project, or none', () => {
    expect(mostRecentProjectId([], ['p1', 'p2'])).toBe('p1');
    expect(mostRecentProjectId([], [])).toBeNull();
  });
});
