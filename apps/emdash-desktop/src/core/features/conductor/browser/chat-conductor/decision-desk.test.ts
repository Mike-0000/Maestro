import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type {
  ConductorDecisionEvent,
  ConductorDecisionRequest,
} from '@core/primitives/agents/api/conductor-decisions';
import { DecisionDesk, type DecidingSession } from './decision-desk';

// The renderer's half of the conductor deciding what the developer is told.

const request = (holdId: string, conversationId = 'conv-1'): ConductorDecisionRequest => ({
  holdId,
  conversationId,
  kind: 'finished',
  completionReport: null,
  completionSummary: null,
  requestedAt: 0,
  ackBy: 5_000,
  decideBy: 45_000,
});

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

function setup(options: { open?: ConductorDecisionRequest[]; takes?: boolean } = {}) {
  const state = observable({ claimable: [] as string[] });
  let emit: (event: ConductorDecisionEvent) => void = () => {};
  let tick: () => void = () => {};
  const session: DecidingSession & { closed: string[] } = {
    closed: [],
    decide: vi.fn(() => options.takes ?? true),
    decisionClosed(holdId) {
      this.closed.push(holdId);
    },
  };
  const deps = {
    claimable: () => state.claimable,
    sessionFor: (conversationId: string) => (conversationId === 'conv-1' ? session : null),
    sessions: () => [session],
    claim: vi.fn(async (_ids: readonly string[]) => ({ ttlMs: 45_000 })),
    ack: vi.fn(async (_holdId: string) => {}),
    resolve: vi.fn(async (_holdId: string, _conversationId: string, _decision: unknown) => ({
      outcome: 'decision',
    })),
    open: vi.fn(async () => options.open ?? []),
    subscribe: vi.fn(async (onEvent: (event: ConductorDecisionEvent) => void) => {
      emit = onEvent;
      return () => {};
    }),
    warn: vi.fn(),
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval: vi.fn(),
  };
  const desk = new DecisionDesk(deps);
  return {
    desk,
    deps,
    session,
    setClaimable: (ids: string[]) => runInAction(() => (state.claimable = ids)),
    emit: (event: ConductorDecisionEvent) => emit(event),
    tick: () => tick(),
  };
}

describe('DecisionDesk', () => {
  it('claims what can be decided, follows it, renews it, and gives it back at the end', async () => {
    const h = setup();
    h.desk.start();
    // Nothing to claim and nothing claimed: nothing to say.
    expect(h.deps.claim).not.toHaveBeenCalled();
    h.setClaimable(['conv-1', 'conv-2']);
    expect(h.deps.claim).toHaveBeenLastCalledWith(['conv-1', 'conv-2']);
    h.tick();
    expect(h.deps.claim).toHaveBeenCalledTimes(2);
    // Conductors turned off, or the setting: everything goes back.
    h.setClaimable([]);
    expect(h.deps.claim).toHaveBeenLastCalledWith([]);
    h.tick();
    expect(h.deps.claim).toHaveBeenCalledTimes(3);
    h.setClaimable(['conv-1']);
    h.desk.dispose();
    expect(h.deps.claim).toHaveBeenLastCalledWith([]);
  });

  it('acknowledges a request its conductor takes, and hands back one nobody can', async () => {
    const h = setup();
    h.desk.start();
    await settle();
    h.emit({ type: 'requested', ...request('hold-1') });
    expect(h.session.decide).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold-1' }));
    expect(h.deps.ack).toHaveBeenCalledWith('hold-1');

    h.emit({ type: 'requested', ...request('hold-2', 'conv-elsewhere') });
    expect(h.deps.resolve).toHaveBeenCalledWith('hold-2', 'conv-elsewhere', {
      kind: 'fallback',
      reason: 'no conductor is following this chat',
    });

    h.emit({ type: 'closed', holdId: 'hold-1', conversationId: 'conv-1', reason: 'superseded' });
    expect(h.session.closed).toEqual(['hold-1']);
    h.desk.dispose();
  });

  it('hands back a request its conductor refuses', async () => {
    const h = setup({ takes: false });
    h.desk.start();
    await settle();
    h.emit({ type: 'requested', ...request('hold-1') });
    expect(h.deps.ack).not.toHaveBeenCalled();
    expect(h.deps.resolve).toHaveBeenCalledWith(
      'hold-1',
      'conv-1',
      expect.objectContaining({ kind: 'fallback' })
    );
    h.desk.dispose();
  });

  it('picks up holds that went out before it was listening', async () => {
    const h = setup({ open: [request('earlier')] });
    h.desk.start();
    await settle();
    expect(h.deps.open).toHaveBeenCalledTimes(1);
    expect(h.deps.ack).toHaveBeenCalledWith('earlier');
    h.desk.dispose();
  });
});
