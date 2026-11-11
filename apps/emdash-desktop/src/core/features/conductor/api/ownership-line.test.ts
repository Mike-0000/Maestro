import { describe, expect, it } from 'vitest';
import {
  isYoursAgent,
  isYoursTaskStatus,
  ownershipCounts,
  ownershipLine,
  taskOwnershipStatus,
} from './ownership-line';

describe('ownershipLine', () => {
  it('says nothing needs you, with or without work going on', () => {
    expect(ownershipLine({ yours: 0, working: 0 })).toBe('Nothing needs you');
    expect(ownershipLine({ yours: 0, working: 2 })).toBe('Nothing needs you · 2 at work');
  });

  it('names what is yours in words', () => {
    expect(ownershipLine({ yours: 1, working: 0 })).toBe('One is yours');
    expect(ownershipLine({ yours: 2, working: 3 })).toBe('Two are yours · 3 at work');
    expect(ownershipLine({ yours: 12, working: 1 })).toBe('Twelve are yours · 1 at work');
  });

  it('uses digits above twelve', () => {
    expect(ownershipLine({ yours: 13, working: 0 })).toBe('13 are yours');
    expect(ownershipLine({ yours: 20, working: 14 })).toBe('20 are yours · 14 at work');
  });

  it('treats negative or broken counts as none', () => {
    expect(ownershipLine({ yours: -1, working: Number.NaN })).toBe('Nothing needs you');
  });
});

describe('ownershipCounts', () => {
  it('counts nothing for no agents', () => {
    expect(ownershipCounts([])).toEqual({ yours: 0, working: 0 });
  });

  it('counts tasks, not agents', () => {
    expect(
      ownershipCounts([
        { taskId: 'a', status: 'working', seen: true },
        { taskId: 'a', status: 'working', seen: true },
        { taskId: 'b', status: 'awaiting-input', seen: false },
        { taskId: 'b', status: 'awaiting-input', seen: false },
        { taskId: 'c', status: 'working', seen: false },
      ])
    ).toEqual({ yours: 1, working: 2 });
  });

  it('does not count a task that is yours as at work too', () => {
    expect(
      ownershipCounts([
        { taskId: 'a', status: 'working', seen: true },
        { taskId: 'a', status: 'awaiting-input', seen: true },
      ])
    ).toEqual({ yours: 1, working: 0 });
    // Order does not matter.
    expect(
      ownershipCounts([
        { taskId: 'a', status: 'awaiting-input', seen: true },
        { taskId: 'a', status: 'working', seen: true },
      ])
    ).toEqual({ yours: 1, working: 0 });
  });

  it('counts finished or failed work as yours until it is seen', () => {
    expect(
      ownershipCounts([
        { taskId: 'a', status: 'completed', seen: false },
        { taskId: 'b', status: 'error', seen: false },
        { taskId: 'c', status: 'completed', seen: true },
        { taskId: 'd', status: 'error', seen: true },
        { taskId: 'e', status: 'idle', seen: false },
      ])
    ).toEqual({ yours: 2, working: 0 });
  });

  it('keeps a waiting agent yours after it was seen', () => {
    expect(ownershipCounts([{ taskId: 'a', status: 'awaiting-input', seen: true }])).toEqual({
      yours: 1,
      working: 0,
    });
  });
});

describe('the yours rule the sidebar rows share', () => {
  it('keeps a waiting agent yours seen or not; a finish or failure only while unseen', () => {
    expect(isYoursAgent({ status: 'awaiting-input', seen: false })).toBe(true);
    expect(isYoursAgent({ status: 'awaiting-input', seen: true })).toBe(true);
    expect(isYoursAgent({ status: 'completed', seen: false })).toBe(true);
    expect(isYoursAgent({ status: 'error', seen: false })).toBe(true);
    expect(isYoursAgent({ status: 'completed', seen: true })).toBe(false);
    expect(isYoursAgent({ status: 'error', seen: true })).toBe(false);
    expect(isYoursAgent({ status: 'working', seen: false })).toBe(false);
    expect(isYoursAgent({ status: 'idle', seen: false })).toBe(false);
  });

  it('gives a task a yours status exactly when the line counts it as yours', () => {
    const cases: { status: 'awaiting-input' | 'working' | 'completed' | 'error' | 'idle' }[] = [
      { status: 'awaiting-input' },
      { status: 'working' },
      { status: 'completed' },
      { status: 'error' },
      { status: 'idle' },
    ];
    for (const { status } of cases) {
      for (const seen of [false, true]) {
        for (const other of [null, { status: 'working' as const, seen: true }]) {
          const agents = [{ status, seen }, ...(other ? [other] : [])];
          const counted = ownershipCounts(agents.map((agent) => ({ ...agent, taskId: 't' })));
          expect(isYoursTaskStatus(taskOwnershipStatus(agents))).toBe(counted.yours === 1);
        }
      }
    }
  });

  it('shows what is yours before work going on', () => {
    expect(
      taskOwnershipStatus([
        { status: 'working', seen: true },
        { status: 'awaiting-input', seen: true },
      ])
    ).toBe('awaiting-input');
    expect(
      taskOwnershipStatus([
        { status: 'working', seen: true },
        { status: 'completed', seen: false },
      ])
    ).toBe('completed');
    expect(
      taskOwnershipStatus([
        { status: 'completed', seen: false },
        { status: 'error', seen: false },
      ])
    ).toBe('error');
    expect(
      taskOwnershipStatus([
        { status: 'working', seen: true },
        { status: 'completed', seen: true },
      ])
    ).toBe('working');
    expect(taskOwnershipStatus([{ status: 'idle', seen: false }])).toBeNull();
    expect(taskOwnershipStatus([])).toBeNull();
  });
});
