import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_ACK_MS,
  DECISION_CLAIM_TTL_MS,
  DECISION_TIMEOUT_MS,
  DECISION_TURN_END_TIMEOUT_MS,
  type ConductorDecisionEvent,
  type ConductorDecisionPolicy,
} from '@core/primitives/agents/api/conductor-decisions';
import {
  ConductorDecisionGate,
  type DecisionClock,
  type HeldEvent,
} from './conductor-decision-gate';

function fakeClock() {
  let now = 1_000;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: DecisionClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now || !timers.has(id)) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

function setup(enabled = true) {
  const time = fakeClock();
  const events: ConductorDecisionEvent[] = [];
  const policy: ConductorDecisionPolicy = {
    enabled: vi.fn(async () => enabled),
    emit: (event) => events.push(event),
  };
  const fallback = vi.fn();
  const decide = vi.fn();
  const gate = new ConductorDecisionGate<string>({ fallback, decide }, time.clock, () => policy);
  return { gate, events, fallback, decide, policy, ...time };
}

const held: HeldEvent<string> = {
  signal: { type: 'stop', conversationId: 'c1', timestamp: 1, payload: {} },
  options: 'options',
  kind: 'finished',
  blocking: false,
  reply: 'Done.',
  report: { text: 'Done.', truncated: false, appUrls: [] },
  summary: 'Done',
};

const prompt: HeldEvent<string> = {
  ...held,
  signal: {
    type: 'notification',
    conversationId: 'c1',
    timestamp: 1,
    payload: { notificationType: 'permission_prompt' },
  },
  kind: 'awaiting-input',
  notificationType: 'permission_prompt',
  blocking: true,
  reply: undefined,
  report: null,
  summary: null,
};

const surface = {
  kind: 'surface',
  state: 'needs_you',
  headline: 'Pick a database',
  notify: true,
} as const;

describe('ConductorDecisionGate', () => {
  it('holds nothing for a conversation that is not claimed, or while decisions are off', async () => {
    const off = setup(false);
    off.gate.claim(['c1']);
    expect(await off.gate.shouldHold('c1')).toBe(false);

    const { gate, policy } = setup();
    expect(await gate.shouldHold('c1')).toBe(false);
    expect(policy.enabled).not.toHaveBeenCalled();
    gate.claim(['c1']);
    expect(await gate.shouldHold('c1')).toBe(true);
    expect(await gate.shouldHold('c2')).toBe(false);
  });

  it('holds nothing without a policy (the conductor slice is not wired)', async () => {
    const gate = new ConductorDecisionGate(
      { fallback: vi.fn(), decide: vi.fn() },
      undefined,
      () => null
    );
    gate.claim(['c1']);
    expect(await gate.shouldHold('c1')).toBe(false);
    gate.dispose();
  });

  it('asks the conductor and applies its decision once', () => {
    const { gate, events, decide, fallback, advance, pending } = setup();
    gate.claim(['c1']);
    const holdId = gate.hold('c1', held);

    expect(gate.isHeld('c1')).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'requested',
      holdId,
      conversationId: 'c1',
      kind: 'finished',
      completionSummary: 'Done',
      requestedAt: 1_000,
      ackBy: 1_000 + DECISION_ACK_MS,
      decideBy: 1_000 + DECISION_TURN_END_TIMEOUT_MS,
    });
    expect(gate.open()).toHaveLength(1);

    gate.ack(holdId);
    expect(gate.resolve(holdId, 'c1', surface)).toBe('decision');
    expect(decide).toHaveBeenCalledWith('c1', held, surface, false);
    expect(events[1]).toEqual({ type: 'closed', holdId, conversationId: 'c1', reason: 'resolved' });
    expect(gate.isHeld('c1')).toBe(false);
    expect(gate.resolve(holdId, 'c1', surface)).toBe('stale');
    // The hold's timers are gone; only the claim's is left.
    expect(pending()).toBe(1);

    advance(DECISION_TIMEOUT_MS);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back without an acknowledgement, and after the decision deadline', () => {
    const noAck = setup();
    noAck.gate.claim(['c1']);
    const first = noAck.gate.hold('c1', held);
    noAck.advance(DECISION_ACK_MS);
    expect(noAck.fallback).toHaveBeenCalledWith('c1', held);
    expect(noAck.events.at(-1)).toMatchObject({
      type: 'closed',
      holdId: first,
      reason: 'fallback',
    });

    const slow = setup();
    slow.gate.claim(['c1']);
    const holdId = slow.gate.hold('c1', prompt);
    slow.gate.ack(holdId);
    slow.advance(DECISION_ACK_MS);
    expect(slow.fallback).not.toHaveBeenCalled();
    slow.gate.claim(['c1']);
    slow.advance(DECISION_TIMEOUT_MS - DECISION_ACK_MS);
    expect(slow.fallback).toHaveBeenCalledTimes(1);
    expect(slow.events.at(-1)).toMatchObject({ type: 'closed', reason: 'timed-out' });
  });

  it('gives a turn end the whole conductor turn, not the prompt deadline', () => {
    const { gate, events, fallback, decide, advance } = setup();
    gate.claim(['c1']);
    const holdId = gate.hold('c1', held);
    expect(events[0]).toMatchObject({ decideBy: 1_000 + DECISION_TURN_END_TIMEOUT_MS });
    gate.ack(holdId);
    // A conductor still reading the chat and acting for the developer at 45 s: nothing is told.
    for (let at = 0; at < DECISION_TIMEOUT_MS + 30_000; at += 15_000) {
      gate.claim(['c1']);
      advance(15_000);
    }
    expect(fallback).not.toHaveBeenCalled();
    // It handled it: its decision is applied as a decision, not as a correction after the fact.
    const quiet = { kind: 'quiet', answered: false } as const;
    expect(gate.resolve(holdId, 'c1', quiet)).toBe('decision');
    expect(decide).toHaveBeenCalledWith('c1', held, quiet, false);
    expect(fallback).not.toHaveBeenCalled();

    // One that never decides still falls back, at the turn-end deadline.
    const stuck = setup();
    stuck.gate.claim(['c1']);
    stuck.gate.ack(stuck.gate.hold('c1', held));
    for (let at = 0; at < DECISION_TURN_END_TIMEOUT_MS - 15_000; at += 15_000) {
      stuck.gate.claim(['c1']);
      stuck.advance(15_000);
    }
    expect(stuck.fallback).not.toHaveBeenCalled();
    stuck.gate.claim(['c1']);
    stuck.advance(15_000);
    expect(stuck.fallback).toHaveBeenCalledTimes(1);
    expect(stuck.events.at(-1)).toMatchObject({ type: 'closed', reason: 'timed-out' });
  });

  it('falls back at once when the conductor cannot decide', () => {
    const { gate, fallback, decide } = setup();
    gate.claim(['c1']);
    const holdId = gate.hold('c1', held);
    expect(gate.resolve(holdId, 'c1', { kind: 'fallback', reason: 'budget' })).toBe('decision');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
  });

  it('takes a late decision after a fallback, unless the agent moved on since', () => {
    const { gate, decide, advance } = setup();
    gate.claim(['c1']);
    const first = gate.hold('c1', held);
    advance(DECISION_ACK_MS);
    gate.claim(['c1']);
    expect(gate.resolve(first, 'c1', surface)).toBe('late');
    expect(decide).toHaveBeenCalledWith('c1', held, surface, true);
    // Taken once.
    expect(gate.resolve(first, 'c1', surface)).toBe('stale');

    const second = gate.hold('c1', held);
    advance(DECISION_ACK_MS);
    gate.supersede('c1');
    expect(gate.resolve(second, 'c1', surface)).toBe('stale');
  });

  it('lets a newer event supersede the open hold, which then decides nothing', () => {
    const { gate, events, fallback, decide } = setup();
    gate.claim(['c1']);
    const first = gate.hold('c1', held);
    const second = gate.hold('c1', { ...held, kind: 'awaiting-input', blocking: true });
    expect(events.map((event) => event.type)).toEqual(['requested', 'closed', 'requested']);
    expect(events[1]).toMatchObject({ holdId: first, reason: 'superseded' });
    expect(gate.resolve(first, 'c1', surface)).toBe('stale');

    gate.supersede('c1');
    expect(gate.resolve(second, 'c1', surface)).toBe('stale');
    expect(fallback).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('never applies a decision to another conversation', () => {
    const { gate, decide } = setup();
    gate.claim(['c1', 'c2']);
    const holdId = gate.hold('c1', held);
    expect(gate.resolve(holdId, 'c2', surface)).toBe('stale');
    expect(decide).not.toHaveBeenCalled();
  });

  it('falls back for conversations given back, and for every hold when the claim lapses', () => {
    const { gate, fallback, advance } = setup();
    gate.claim(['c1', 'c2']);
    gate.hold('c1', held);
    gate.hold('c2', held);
    gate.claim(['c2']);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('c1', held);

    gate.ack(gate.open()[0]!.holdId);
    advance(DECISION_CLAIM_TTL_MS);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(gate.isHeld('c2')).toBe(false);
  });

  it('shows whatever is still held when it is disposed', () => {
    const { gate, fallback } = setup();
    gate.claim(['c1']);
    gate.hold('c1', held);
    gate.dispose();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
