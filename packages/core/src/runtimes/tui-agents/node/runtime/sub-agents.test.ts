import { describe, expect, it } from 'vitest';
import {
  cleanLabel,
  MAX_TRACKED_SUB_AGENTS,
  sameSubAgents,
  SUB_AGENT_LABEL_MAX_CHARS,
  SubAgentSet,
} from './sub-agents';

const ids = (set: SubAgentSet) => (set.list() ?? []).map((agent) => agent.id);

describe('SubAgentSet', () => {
  it('lists a started sub-agent by its type until it stops', () => {
    const set = new SubAgentSet();
    expect(set.started({ agentId: 'a1', agentType: 'Explore' }, 10)).toBe(true);
    expect(set.list()).toEqual([
      { id: 'a1', label: 'Explore', agentType: 'Explore', startedAt: 10 },
    ]);

    expect(set.stopped('a1')).toBe(true);
    expect(set.list()).toBeUndefined();
    expect(set.stopped('a1')).toBe(false);
  });

  it('keeps interleaved sub-agents apart, oldest first', () => {
    const set = new SubAgentSet();
    set.started({ agentId: 'a1', agentType: 'Explore' }, 10);
    set.started({ agentId: 'a2', agentType: 'Plan' }, 20);
    set.stopped('a1');
    set.started({ agentId: 'a3' }, 30);

    expect(ids(set)).toEqual(['a2', 'a3']);
    expect(set.list()?.[1]).toEqual({ id: 'a3', label: 'sub-agent', startedAt: 30 });
  });

  it('keeps the first start time when a start repeats', () => {
    const set = new SubAgentSet();
    set.started({ agentId: 'a1', agentType: 'Explore' }, 10);
    expect(set.started({ agentId: 'a1', agentType: 'Explore' }, 50)).toBe(false);
    expect(set.list()?.[0]?.startedAt).toBe(10);
  });

  it('takes the task description a stop lists for a sub-agent still running', () => {
    const set = new SubAgentSet();
    set.started({ agentId: 'a1', agentType: 'general-purpose' }, 10);
    set.started({ agentId: 'a2', agentType: 'Explore' }, 20);

    expect(
      set.stopped('a2', [
        { agentId: 'a1', agentType: 'general-purpose', description: 'Review the diff' },
        { agentId: 'a9', description: 'never started here' },
      ])
    ).toBe(true);

    expect(set.list()).toEqual([
      { id: 'a1', label: 'Review the diff', agentType: 'general-purpose', startedAt: 10 },
    ]);
  });

  it('leaves exactly the background sub-agents when the turn ends', () => {
    const set = new SubAgentSet();
    set.started({ agentId: 'fg', agentType: 'Explore' }, 10);
    set.started({ agentId: 'bg', agentType: 'general-purpose' }, 20);

    expect(
      set.turnEnded(
        [
          { agentId: 'bg', description: 'Run the tests' },
          { agentId: 'older', agentType: 'Plan', description: 'Plan the migration' },
        ],
        99
      )
    ).toBe(true);

    expect(set.list()).toEqual([
      { id: 'bg', label: 'Run the tests', agentType: 'general-purpose', startedAt: 20 },
      { id: 'older', label: 'Plan the migration', agentType: 'Plan', startedAt: 99 },
    ]);
    expect(set.turnEnded([{ agentId: 'bg' }, { agentId: 'older' }], 200)).toBe(false);
    expect(set.turnEnded([], 300)).toBe(true);
    expect(set.list()).toBeUndefined();
  });

  it('drops foreground sub-agents on an interrupt and keeps background ones', () => {
    const set = new SubAgentSet();
    set.started({ agentId: 'fg' }, 10);
    set.started({ agentId: 'bg' }, 20);
    set.stopped('other', [{ agentId: 'bg', description: 'Watch the build' }]);

    expect(set.interrupted()).toBe(true);
    expect(ids(set)).toEqual(['bg']);
    expect(set.interrupted()).toBe(false);
  });

  it('tracks a bounded number of sub-agents', () => {
    const set = new SubAgentSet();
    for (let index = 0; index < MAX_TRACKED_SUB_AGENTS + 5; index += 1) {
      set.started({ agentId: `a${index}` }, index);
    }
    expect(set.size).toBe(MAX_TRACKED_SUB_AGENTS);
    expect(set.started({ agentId: 'late' }, 1_000)).toBe(false);
  });
});

describe('cleanLabel', () => {
  it('bounds a long description with an ellipsis', () => {
    const label = cleanLabel('x'.repeat(500))!;
    expect(label).toHaveLength(SUB_AGENT_LABEL_MAX_CHARS);
    expect(label.endsWith('…')).toBe(true);
  });

  it('never cuts a character in two', () => {
    const label = cleanLabel(`${'x'.repeat(SUB_AGENT_LABEL_MAX_CHARS - 2)}\u{1F600}tail`)!;
    expect(label).toBe(`${'x'.repeat(SUB_AGENT_LABEL_MAX_CHARS - 2)}…`);
  });

  it('puts the text on one line without control characters', () => {
    expect(cleanLabel('  Fix\nthe\u001b[31m tests\t ')).toBe('Fix the [31m tests');
  });

  it('redacts secrets the model wrote into a description', () => {
    const label = cleanLabel('Call the API with ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(label).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('reads blank text as none', () => {
    expect(cleanLabel('  \n ')).toBeUndefined();
    expect(cleanLabel(undefined)).toBeUndefined();
  });
});

describe('sameSubAgents', () => {
  it('compares lists by what they show', () => {
    const a = [{ id: 'a1', label: 'Explore', startedAt: 1 }];
    expect(sameSubAgents(a, [{ ...a[0]! }])).toBe(true);
    expect(sameSubAgents(a, [{ ...a[0]!, label: 'Other' }])).toBe(false);
    expect(sameSubAgents(undefined, undefined)).toBe(true);
    expect(sameSubAgents(a, undefined)).toBe(false);
  });
});
