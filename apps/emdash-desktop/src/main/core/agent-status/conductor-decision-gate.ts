import { randomUUID } from 'node:crypto';
import type { AgentStatusSignal, NotificationType } from '@core/primitives/agents/api';
import type { CompletionReport } from '@core/primitives/agents/api/completion-report';
import {
  DECISION_ACK_MS,
  DECISION_CLAIM_TTL_MS,
  DECISION_TIMEOUT_MS,
  getConductorDecisionPolicy,
  type ConductorDecision,
  type ConductorDecisionCloseReason,
  type ConductorDecisionEvent,
  type ConductorDecisionHost,
  type ConductorDecisionOutcome,
  type ConductorDecisionPolicy,
  type ConductorDecisionRequest,
} from '@core/primitives/agents/api/conductor-decisions';

/** An event held for a conductor's decision: what main would otherwise have applied. */
export type HeldEvent<Options = unknown> = {
  readonly signal: AgentStatusSignal;
  readonly options: Options;
  readonly kind: 'finished' | 'awaiting-input';
  readonly notificationType?: NotificationType;
  /** A permission or elicitation prompt: the agent cannot go on until it is answered. */
  readonly blocking: boolean;
  /** The turn's final reply as the request carried it; published again with the decision. */
  readonly reply: string | undefined;
  readonly report: CompletionReport | null;
  readonly summary: string | null;
};

/** A decision main applies: what the conductor said, never a fallback. */
export type AppliedDecision = Exclude<ConductorDecision, { kind: 'fallback' }>;

export type ConductorDecisionGateCallbacks<Options> = {
  /** Applies what the event would have shown without a conductor (rules and verdicts). */
  fallback(conversationId: string, held: HeldEvent<Options>): void;
  /**
   * Applies the conductor's decision. `late` when main had fallen back already: the indicator may
   * still be corrected, a notification only when the fallback did not already ask for attention.
   */
  decide(
    conversationId: string,
    held: HeldEvent<Options>,
    decision: AppliedDecision,
    late: boolean
  ): void;
  warn?(message: string, context: Record<string, unknown>): void;
};

export type DecisionClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemClock: DecisionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Hold<Options> = {
  readonly request: ConductorDecisionRequest;
  readonly held: HeldEvent<Options>;
  acked: boolean;
  timers: unknown[];
};

/**
 * Main's side of the conductor's decisions (see `conductor-decisions.ts`): which conversations
 * the renderer claimed, the events held for them, and the timers that fall back when no decision
 * comes. Every hold ends exactly once: decided, superseded, or fallen back.
 */
export class ConductorDecisionGate<Options = unknown> implements ConductorDecisionHost {
  private claimed = new Set<string>();
  private claimTimer: unknown = null;
  /** The open hold per conversation; a newer event replaces it. */
  private readonly holds = new Map<string, Hold<Options>>();
  /** The latest hold that fell back per conversation, while nothing newer happened there. */
  private readonly fellBack = new Map<string, { holdId: string; held: HeldEvent<Options> }>();

  constructor(
    private readonly callbacks: ConductorDecisionGateCallbacks<Options>,
    private readonly clock: DecisionClock = systemClock,
    private readonly policy: () => ConductorDecisionPolicy | null = getConductorDecisionPolicy
  ) {}

  /** Whether an event of this conversation is to be held: it is claimed and decisions are on. */
  async shouldHold(conversationId: string): Promise<boolean> {
    if (!this.claimed.has(conversationId)) return false;
    const policy = this.policy();
    if (!policy) return false;
    return policy.enabled().catch(() => false);
  }

  /** An event of this conversation waits on its conductor. */
  isHeld(conversationId: string): boolean {
    return this.holds.has(conversationId);
  }

  /** Holds an event and asks the conductor. Returns the hold's id. */
  hold(conversationId: string, held: HeldEvent<Options>): string {
    this.supersede(conversationId);
    const now = this.clock.now();
    const request: ConductorDecisionRequest = {
      holdId: randomUUID(),
      conversationId,
      kind: held.kind,
      ...(held.notificationType ? { notificationType: held.notificationType } : {}),
      completionReport: held.report,
      completionSummary: held.summary,
      requestedAt: now,
      ackBy: now + DECISION_ACK_MS,
      decideBy: now + DECISION_TIMEOUT_MS,
    };
    const hold: Hold<Options> = { request, held, acked: false, timers: [] };
    this.holds.set(conversationId, hold);
    hold.timers.push(
      this.clock.setTimeout(() => {
        if (!hold.acked) this.fallBack(hold, 'fallback', 'not acknowledged');
      }, DECISION_ACK_MS),
      this.clock.setTimeout(
        () => this.fallBack(hold, 'timed-out', 'no decision'),
        DECISION_TIMEOUT_MS
      )
    );
    this.emit({ type: 'requested', ...request });
    return request.holdId;
  }

  /**
   * Something newer happened in the conversation (a turn started, another prompt, an error, the
   * session ended): an open hold has nothing left to decide, and a late decision is not taken.
   */
  supersede(conversationId: string): void {
    this.fellBack.delete(conversationId);
    const hold = this.holds.get(conversationId);
    if (!hold) return;
    this.close(hold, 'superseded');
  }

  claim(conversationIds: readonly string[]): { ttlMs: number } {
    this.claimed = new Set(conversationIds);
    if (this.claimTimer !== null) this.clock.clearTimeout(this.claimTimer);
    this.claimTimer =
      this.claimed.size > 0
        ? this.clock.setTimeout(() => this.claimLapsed(), DECISION_CLAIM_TTL_MS)
        : null;
    // A conversation given back decides nothing more: what it waits on falls back now.
    for (const hold of [...this.holds.values()]) {
      if (!this.claimed.has(hold.request.conversationId)) {
        this.fallBack(hold, 'fallback', 'claim released');
      }
    }
    return { ttlMs: DECISION_CLAIM_TTL_MS };
  }

  ack(holdId: string): void {
    for (const hold of this.holds.values()) {
      if (hold.request.holdId === holdId) hold.acked = true;
    }
  }

  resolve(
    holdId: string,
    conversationId: string,
    decision: ConductorDecision
  ): ConductorDecisionOutcome {
    const hold = this.holds.get(conversationId);
    if (hold?.request.holdId === holdId) {
      if (decision.kind === 'fallback') {
        this.fallBack(hold, 'fallback', decision.reason);
        return 'decision';
      }
      this.close(hold, 'resolved');
      this.callbacks.decide(conversationId, hold.held, decision, false);
      return 'decision';
    }
    const missed = this.fellBack.get(conversationId);
    if (missed?.holdId === holdId && decision.kind !== 'fallback') {
      this.fellBack.delete(conversationId);
      this.callbacks.decide(conversationId, missed.held, decision, true);
      return 'late';
    }
    return 'stale';
  }

  open(): ConductorDecisionRequest[] {
    return [...this.holds.values()].map((hold) => hold.request);
  }

  dispose(): void {
    if (this.claimTimer !== null) this.clock.clearTimeout(this.claimTimer);
    this.claimTimer = null;
    this.claimed.clear();
    for (const hold of [...this.holds.values()]) this.fallBack(hold, 'fallback', 'shutting down');
    this.fellBack.clear();
  }

  private claimLapsed(): void {
    this.claimTimer = null;
    this.claimed.clear();
    for (const hold of [...this.holds.values()]) this.fallBack(hold, 'fallback', 'claim lapsed');
  }

  private fallBack(hold: Hold<Options>, reason: ConductorDecisionCloseReason, why: string): void {
    if (this.holds.get(hold.request.conversationId) !== hold) return;
    const { conversationId, holdId } = hold.request;
    this.callbacks.warn?.('conductor decision: falling back', { conversationId, holdId, why });
    this.close(hold, reason);
    this.fellBack.set(conversationId, { holdId, held: hold.held });
    this.callbacks.fallback(conversationId, hold.held);
  }

  private close(hold: Hold<Options>, reason: ConductorDecisionCloseReason): void {
    const { conversationId, holdId } = hold.request;
    for (const timer of hold.timers) this.clock.clearTimeout(timer);
    hold.timers = [];
    if (this.holds.get(conversationId) === hold) this.holds.delete(conversationId);
    this.emit({ type: 'closed', holdId, conversationId, reason });
  }

  private emit(event: ConductorDecisionEvent): void {
    try {
      this.policy()?.emit(event);
    } catch (error) {
      this.callbacks.warn?.('conductor decision: event not delivered', {
        type: event.type,
        error: String(error),
      });
    }
  }
}
