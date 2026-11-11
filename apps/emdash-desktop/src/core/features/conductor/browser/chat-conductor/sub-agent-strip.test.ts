import { describe, expect, it } from 'vitest';
import {
  chatSubAgents,
  runningSubAgents,
  subAgentChatSummary,
  taskSubAgents,
  type LabeledSubAgent,
  type RunningSubAgents,
} from './sub-agent-strip';

describe('runningSubAgents', () => {
  it('reads no report as none running', () => {
    expect(runningSubAgents(null)).toBe(0);
    expect(runningSubAgents(undefined)).toBe(0);
  });

  it('never goes below zero or between whole agents', () => {
    expect(runningSubAgents(-2)).toBe(0);
    expect(runningSubAgents(2.9)).toBe(2);
    expect(runningSubAgents(Number.NaN)).toBe(0);
  });
});

const named = (...ids: string[]): LabeledSubAgent[] =>
  ids.map((id) => ({ id, label: `task ${id}` }));
const ids = (running: RunningSubAgents) =>
  typeof running === 'number' ? running : running.map((agent) => agent.id);

describe('chatSubAgents', () => {
  it('names the sub-agents when the host reports them, and counts otherwise', () => {
    const agents = named('a');
    expect(chatSubAgents(agents, 4)).toBe(agents);
    expect(chatSubAgents([], 4)).toBe(4);
    expect(chatSubAgents(undefined, null)).toBe(0);
  });
});

describe('taskSubAgents', () => {
  it('shows nothing for a task with no chats or none running', () => {
    expect(taskSubAgents([])).toBe(0);
    expect(taskSubAgents([{ id: 'c1', name: 'Atlas' }])).toBe(0);
    expect(
      taskSubAgents([
        { id: 'c1', name: 'Atlas' },
        { id: 'c2', name: 'Bravo', waitingOn: null },
      ])
    ).toEqual([]);
  });

  it('keeps one chat as it was: its count, or its named sub-agents without a chat name', () => {
    expect(taskSubAgents([{ id: 'c1', name: 'Atlas', waitingOn: 3 }])).toBe(3);
    expect(
      taskSubAgents([
        { id: 'c1', name: 'Atlas', named: [{ id: 'a', label: 'task a', agentType: 'Explore' }] },
      ])
    ).toEqual([{ id: 'c1/a', label: 'task a', agentType: 'Explore' }]);
  });

  it('merges several chats in order, each sub-agent with its chat', () => {
    expect(
      taskSubAgents([
        { id: 'c1', name: 'Atlas', named: named('a', 'b'), waitingOn: 5 },
        { id: 'c2', name: 'Bravo', named: named('a') },
      ])
    ).toEqual([
      { id: 'c1/a', label: 'task a', chat: 'Atlas' },
      { id: 'c1/b', label: 'task b', chat: 'Atlas' },
      { id: 'c2/a', label: 'task a', chat: 'Bravo' },
    ]);
  });

  it('adds one unnamed entry per sub-agent a chat only counts', () => {
    const merged = taskSubAgents([
      { id: 'c1', name: 'Atlas', named: named('a') },
      { id: 'c2', name: 'Bravo', waitingOn: 2 },
    ]);
    expect(merged).toEqual([
      { id: 'c1/a', label: 'task a', chat: 'Atlas' },
      { id: 'c2/#0', label: 'sub-agent', counted: true, chat: 'Bravo' },
      { id: 'c2/#1', label: 'sub-agent', counted: true, chat: 'Bravo' },
    ]);
  });

  it('keeps a sub-agent id when the task gains a chat', () => {
    const alone = taskSubAgents([{ id: 'c1', name: 'Atlas', named: named('a', 'b') }]);
    const joined = taskSubAgents([
      { id: 'c1', name: 'Atlas', named: named('a', 'b') },
      { id: 'c2', name: 'Bravo', named: named('a') },
    ]);
    expect(ids(alone)).toEqual(['c1/a', 'c1/b']);
    expect(ids(joined)).toEqual(['c1/a', 'c1/b', 'c2/a']);
  });

  it('drops the unnamed entries of a chat from the end as its count drops', () => {
    const chats = (waitingOn: number) => [
      { id: 'c1', name: 'Atlas', waitingOn: 1 },
      { id: 'c2', name: 'Bravo', waitingOn },
    ];
    expect(ids(taskSubAgents(chats(2)))).toEqual(['c1/#0', 'c2/#0', 'c2/#1']);
    expect(ids(taskSubAgents(chats(1)))).toEqual(['c1/#0', 'c2/#0']);
  });
});

describe('subAgentChatSummary', () => {
  it('says how the sub-agents split over the chats', () => {
    expect(
      subAgentChatSummary(
        taskSubAgents([
          { id: 'c1', name: 'Atlas', named: named('a', 'b') },
          { id: 'c2', name: 'Bravo', waitingOn: 1 },
          { id: 'c3', name: 'Atlas', named: named('c') },
        ])
      )
    ).toBe('3 in Atlas, 1 in Bravo');
  });

  it('says nothing for one chat or a bare count', () => {
    expect(subAgentChatSummary(3)).toBeNull();
    expect(subAgentChatSummary(named('a'))).toBeNull();
    expect(subAgentChatSummary([])).toBeNull();
  });
});
