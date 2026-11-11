import { describe, expect, it } from 'vitest';
import {
  advanceNamedSubAgentStrip,
  advanceSubAgentStrip,
  advanceSubAgentStripTo,
  chatSubAgents,
  EMPTY_SUB_AGENT_STRIP,
  hasLeavingSubAgents,
  MAX_LABELED_SUB_AGENTS,
  MAX_SUB_AGENT_SLOTS,
  runningSubAgents,
  settleSubAgentStrip,
  showsSubAgentLabels,
  subAgentSlotMotion,
  subAgentsKey,
  subAgentTitle,
  type LabeledSubAgent,
  type SubAgentStripState,
} from './sub-agent-strip';

const present = (...indexes: number[]) => indexes.map((index) => ({ index, leaving: false }));

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

describe('advanceSubAgentStrip', () => {
  it('stays empty while none run', () => {
    expect(advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 0)).toBe(EMPTY_SUB_AGENT_STRIP);
  });

  it('gives each running sub-agent a place', () => {
    expect(advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 3)).toEqual({
      count: 3,
      slots: present(0, 1, 2),
      overflow: 0,
      leaving: false,
    });
  });

  it('keeps the places of finished sub-agents until they are settled', () => {
    const three = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 3);
    const one = advanceSubAgentStrip(three, 1);
    expect(one.count).toBe(1);
    expect(one.slots).toEqual([
      { index: 0, leaving: false },
      { index: 1, leaving: true },
      { index: 2, leaving: true },
    ]);
    expect(hasLeavingSubAgents(one)).toBe(true);

    const settled = settleSubAgentStrip(one);
    expect(settled.slots).toEqual(present(0));
    expect(hasLeavingSubAgents(settled)).toBe(false);
  });

  it('brings a leaving place back when a sub-agent starts before it settled', () => {
    const two = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 2);
    const back = advanceSubAgentStrip(advanceSubAgentStrip(two, 1), 2);
    expect(back.slots).toEqual(present(0, 1));
  });

  it('keeps the last count on the caption while the last sub-agents leave', () => {
    const two = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 2);
    const none = advanceSubAgentStrip(two, 0);
    expect(none.count).toBe(2);
    expect(none.leaving).toBe(true);
    expect(none.slots.every((slot) => slot.leaving)).toBe(true);
    expect(advanceSubAgentStrip(none, 0)).toEqual(none);
    expect(settleSubAgentStrip(none)).toBe(EMPTY_SUB_AGENT_STRIP);
  });

  it('draws a bounded number of places and counts the rest', () => {
    const many = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, MAX_SUB_AGENT_SLOTS + 4);
    expect(many.count).toBe(MAX_SUB_AGENT_SLOTS + 4);
    expect(many.slots).toHaveLength(MAX_SUB_AGENT_SLOTS);
    expect(many.overflow).toBe(4);

    const fewer = advanceSubAgentStrip(many, MAX_SUB_AGENT_SLOTS + 1);
    expect(fewer.slots).toEqual(many.slots);
    expect(fewer.overflow).toBe(1);
  });
});

describe('settleSubAgentStrip', () => {
  it('returns the same strip when nothing is leaving', () => {
    const two = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 2);
    expect(settleSubAgentStrip(two)).toBe(two);
  });
});

describe('subAgentSlotMotion', () => {
  it('is the same for a place every time', () => {
    expect(subAgentSlotMotion(3, 4)).toEqual(subAgentSlotMotion(3, 4));
  });

  it('never gives neighbours the same colour, pace or direction', () => {
    for (let index = 0; index + 1 < MAX_SUB_AGENT_SLOTS; index += 1) {
      const a = subAgentSlotMotion(index, 4);
      const b = subAgentSlotMotion(index + 1, 4);
      expect(a.tone).not.toBe(b.tone);
      expect(a.orbitMs).not.toBe(b.orbitMs);
      expect(a.reverse).not.toBe(b.reverse);
      expect(b.enterDelayMs).toBeGreaterThan(a.enterDelayMs);
    }
  });

  it('keeps every value in range', () => {
    for (let index = 0; index < MAX_SUB_AGENT_SLOTS; index += 1) {
      const motion = subAgentSlotMotion(index, 4);
      expect(motion.tone).toBeGreaterThanOrEqual(0);
      expect(motion.tone).toBeLessThan(4);
      expect(motion.orbitMs).toBeGreaterThanOrEqual(3200);
      expect(motion.orbitMs).toBeLessThanOrEqual(5300);
      expect(motion.startDeg).toBeGreaterThanOrEqual(0);
      expect(motion.startDeg).toBeLessThan(360);
    }
    expect(subAgentSlotMotion(5, 0).tone).toBe(0);
  });
});

const named = (...ids: string[]): LabeledSubAgent[] =>
  ids.map((id) => ({ id, label: `task ${id}` }));
/** Which sub-agent holds each place, in place order; leaving ones marked with a "-". */
const places = (state: SubAgentStripState) =>
  state.slots.map((slot) => `${slot.index}:${slot.leaving ? '-' : ''}${slot.agent?.id ?? '?'}`);

describe('chatSubAgents', () => {
  it('names the sub-agents when the host reports them, and counts otherwise', () => {
    const agents = named('a');
    expect(chatSubAgents(agents, 4)).toBe(agents);
    expect(chatSubAgents([], 4)).toBe(4);
    expect(chatSubAgents(undefined, null)).toBe(0);
  });
});

describe('subAgentsKey', () => {
  it('changes with what the strip shows, not with array identity', () => {
    expect(subAgentsKey(named('a', 'b'))).toBe(subAgentsKey(named('a', 'b')));
    expect(subAgentsKey(named('a'))).not.toBe(subAgentsKey([{ id: 'a', label: 'other' }]));
    expect(subAgentsKey(2)).not.toBe(subAgentsKey(named('a', 'b')));
  });
});

describe('advanceNamedSubAgentStrip', () => {
  it('gives each named sub-agent a place with its label', () => {
    const strip = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a', 'b'));
    expect(strip.count).toBe(2);
    expect(places(strip)).toEqual(['0:a', '1:b']);
    expect(strip.slots[0]?.agent?.label).toBe('task a');
  });

  it('keeps each sub-agent in its place while others come and go', () => {
    const ab = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a', 'b'));
    const b = advanceNamedSubAgentStrip(ab, named('b'));
    expect(places(b)).toEqual(['0:-a', '1:b']);
    expect(b.slots[0]?.agent?.label).toBe('task a');

    // A newcomer takes a free place, not the one still playing its exit.
    const bc = advanceNamedSubAgentStrip(b, named('b', 'c'));
    expect(places(bc)).toEqual(['0:-a', '1:b', '2:c']);

    const settled = settleSubAgentStrip(bc);
    expect(places(settled)).toEqual(['1:b', '2:c']);
    expect(places(advanceNamedSubAgentStrip(settled, named('b', 'c', 'd')))).toEqual([
      '0:d',
      '1:b',
      '2:c',
    ]);
  });

  it('brings a sub-agent back to its own place when it is reported again before settling', () => {
    const ab = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a', 'b'));
    const back = advanceNamedSubAgentStrip(
      advanceNamedSubAgentStrip(ab, named('b')),
      named('a', 'b')
    );
    expect(places(back)).toEqual(['0:a', '1:b']);
  });

  it('updates a label in place', () => {
    const before = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a'));
    const after = advanceNamedSubAgentStrip(before, [{ id: 'a', label: 'Run the tests' }]);
    expect(places(after)).toEqual(['0:a']);
    expect(after.slots[0]?.agent?.label).toBe('Run the tests');
  });

  it('takes over the places counted sub-agents held once the host names them', () => {
    const counted = advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 3);
    const strip = advanceNamedSubAgentStrip(counted, named('a', 'b'));
    expect(places(strip)).toEqual(['0:a', '1:b', '2:-?']);
  });

  it('falls back to counted places, keeping the slots that still fit', () => {
    const strip = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a', 'b'));
    expect(places(advanceSubAgentStripTo(strip, 1))).toEqual(['0:?', '1:-b']);
  });

  it('lets the last sub-agents leave with their labels and the caption', () => {
    const ab = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named('a', 'b'));
    const none = advanceNamedSubAgentStrip(ab, []);
    expect(none.leaving).toBe(true);
    expect(none.count).toBe(2);
    expect(places(none)).toEqual(['0:-a', '1:-b']);
    expect(settleSubAgentStrip(none)).toBe(EMPTY_SUB_AGENT_STRIP);
  });

  it('draws a bounded number of places and counts the newest past them', () => {
    const ids = Array.from({ length: MAX_SUB_AGENT_SLOTS + 2 }, (_, index) => `a${index}`);
    const strip = advanceNamedSubAgentStrip(EMPTY_SUB_AGENT_STRIP, named(...ids));
    expect(strip.slots).toHaveLength(MAX_SUB_AGENT_SLOTS);
    expect(strip.overflow).toBe(2);
    expect(strip.slots.map((slot) => slot.agent?.id)).toEqual(ids.slice(0, MAX_SUB_AGENT_SLOTS));
  });
});

describe('showsSubAgentLabels', () => {
  it('shows labels for a few named sub-agents only', () => {
    const few = advanceNamedSubAgentStrip(
      EMPTY_SUB_AGENT_STRIP,
      named(...Array.from({ length: MAX_LABELED_SUB_AGENTS }, (_, index) => `a${index}`))
    );
    expect(showsSubAgentLabels(few)).toBe(true);
    expect(
      showsSubAgentLabels(
        advanceNamedSubAgentStrip(
          few,
          named(...Array.from({ length: MAX_LABELED_SUB_AGENTS + 1 }, (_, index) => `a${index}`))
        )
      )
    ).toBe(false);
    expect(showsSubAgentLabels(advanceSubAgentStrip(EMPTY_SUB_AGENT_STRIP, 1))).toBe(false);
    expect(showsSubAgentLabels(EMPTY_SUB_AGENT_STRIP)).toBe(false);
  });
});

describe('subAgentTitle', () => {
  it('adds the type when it says something the label does not', () => {
    expect(subAgentTitle({ id: 'a', label: 'Run the tests', agentType: 'general-purpose' })).toBe(
      'Run the tests (general-purpose)'
    );
    expect(subAgentTitle({ id: 'a', label: 'Explore', agentType: 'Explore' })).toBe('Explore');
  });
});
