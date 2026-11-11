import { reaction } from 'mobx';
import {
  DECISION_CLAIM_RENEW_MS,
  type ConductorDecision,
  type ConductorDecisionEvent,
  type ConductorDecisionRequest,
} from '@core/primitives/agents/api/conductor-decisions';
import type { DecisionRequest } from './session';

/** What the desk needs of a task's conductor session. */
export interface DecidingSession {
  decide(request: DecisionRequest): boolean;
  decisionClosed(holdId: string): void;
}

export type DecisionDeskDeps = {
  /** The conversations whose conductor can decide right now; read inside a reaction. */
  claimable(): readonly string[];
  /** The conductor of a conversation's task, when one exists. */
  sessionFor(conversationId: string): DecidingSession | null;
  sessions(): Iterable<DecidingSession>;
  claim(conversationIds: readonly string[]): Promise<unknown>;
  ack(holdId: string): Promise<unknown>;
  resolve(holdId: string, conversationId: string, decision: ConductorDecision): Promise<unknown>;
  open(): Promise<readonly ConductorDecisionRequest[]>;
  subscribe(onEvent: (event: ConductorDecisionEvent) => void): Promise<() => void>;
  warn(message: string, data?: Record<string, unknown>): void;
  setInterval?(callback: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
};

/**
 * The renderer's side of the conductor deciding what the developer is told (see
 * `conductor-decisions.ts`): which conversations it claims, renewed while they stay claimable;
 * each held event handed to its task's conductor and acknowledged, or handed straight back; and
 * holds still open from before a reload picked up again. One per app, owned by the manager.
 */
export class DecisionDesk {
  private readonly disposers: (() => void)[] = [];
  private claimed: readonly string[] = [];
  private disposed = false;

  constructor(private readonly deps: DecisionDeskDeps) {}

  start(): void {
    this.disposers.push(
      reaction(
        () => [...this.deps.claimable()].sort().join('\n'),
        () => this.claim(),
        { fireImmediately: true }
      )
    );
    const setTimer = this.deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const clearTimer =
      this.deps.clearInterval ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    // A claim lapses unless renewed.
    const timer = setTimer(() => {
      if (this.claimed.length > 0) this.claim();
    }, DECISION_CLAIM_RENEW_MS);
    this.disposers.push(() => clearTimer(timer));
    void this.deps
      .subscribe((event) => this.onEvent(event))
      .then(
        (unsubscribe) => {
          if (this.disposed) unsubscribe();
          else this.disposers.push(unsubscribe);
          // Holds that went out before this renderer was listening (a reload).
          return this.deps.open();
        },
        (error: unknown) => {
          this.deps.warn('conductor decisions: could not listen for requests', { error });
          return [] as readonly ConductorDecisionRequest[];
        }
      )
      .then((open) => {
        for (const request of open) this.take(request);
      })
      .catch((error: unknown) =>
        this.deps.warn('conductor decisions: open requests could not be read', { error })
      );
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    // Everything goes back to main's rules.
    if (this.claimed.length > 0) {
      this.claimed = [];
      void this.deps.claim([]).catch(() => {});
    }
  }

  private claim(): void {
    if (this.disposed) return;
    const ids = [...this.deps.claimable()];
    // Nothing claimed and nothing to claim: main holds nothing, there is nothing to say.
    if (ids.length === 0 && this.claimed.length === 0) return;
    this.claimed = ids;
    void this.deps
      .claim(ids)
      .catch((error: unknown) => this.deps.warn('conductor decisions: claim failed', { error }));
  }

  private onEvent(event: ConductorDecisionEvent): void {
    if (this.disposed) return;
    if (event.type === 'closed') {
      for (const session of this.deps.sessions()) session.decisionClosed(event.holdId);
      return;
    }
    this.take(event);
  }

  /** Hands a held event to its conductor and acknowledges it, or hands it back to main at once. */
  private take(request: ConductorDecisionRequest): void {
    const taken = this.deps.sessionFor(request.conversationId)?.decide(request) ?? false;
    const done = taken
      ? this.deps.ack(request.holdId)
      : this.deps.resolve(request.holdId, request.conversationId, {
          kind: 'fallback',
          reason: 'no conductor is following this chat',
        });
    void done.catch((error: unknown) =>
      this.deps.warn('conductor decisions: could not answer a request', { error })
    );
  }
}
