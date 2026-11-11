import type { NotificationType } from './agent-events';
import type { CompletionReport } from './completion-report';

/**
 * The seam through which a chat's conductor, not rules or a one-shot verdict, decides what the
 * developer is shown and told when that chat's agent ends a turn or waits on them.
 *
 * Main owns the hold: for a conversation the renderer has claimed (`claim`), a turn end or an
 * attention prompt is held, nothing is published or notified, and a `requested` event goes out.
 * The renderer's conductor answers with `resolve`. Whatever goes wrong (no acknowledgement within
 * `DECISION_ACK_MS`, no decision within `DECISION_TIMEOUT_MS`, the claim lapsing, the conductor
 * unable to run) falls back to the status and notifications the event would have had without a
 * conductor, so a real "needs you" is never lost. Without claims nothing is held.
 */

/** How long the renderer has to acknowledge a request before main falls back. */
export const DECISION_ACK_MS = 5_000;
/** How long, from the request, the conductor has to decide before main falls back. */
export const DECISION_TIMEOUT_MS = 45_000;
/** How long a claim lives without being renewed. */
export const DECISION_CLAIM_TTL_MS = 45_000;
/** How often the renderer should renew its claim. */
export const DECISION_CLAIM_RENEW_MS = 15_000;
/** Bounds on the conductor's own text, as main publishes it. */
export const DECISION_HEADLINE_CHARS = 200;
export const DECISION_DETAIL_CHARS = 200;

/** What the conductor decided about one held event. */
export type ConductorDecision =
  /** Show it: the indicator becomes needs-you (awaiting-input) or done (completed). */
  | {
      readonly kind: 'surface';
      readonly state: 'needs_you' | 'done';
      /** One line the developer can take in at a glance; the notification's text. */
      readonly headline: string;
      /** A little more for the notification body. */
      readonly detail?: string;
      /** Whether a notification (sound, desktop banner, phone push) goes out. */
      readonly notify: boolean;
    }
  /**
   * Nothing for the developer: no dot, no notification. For a permission or elicitation prompt,
   * `answered` says the conductor answered it (or saw the agent go on); without it the prompt is
   * still blocking and keeps a silent needs-you dot, since answering emits no hook main could see.
   */
  | { readonly kind: 'quiet'; readonly answered?: boolean }
  /** The conductor could not decide: main applies what it would have without one, at once. */
  | { readonly kind: 'fallback'; readonly reason: string };

/** A held event the conductor of `conversationId` is asked to decide. Times are Unix ms. */
export type ConductorDecisionRequest = {
  readonly holdId: string;
  readonly conversationId: string;
  /** finished: a turn ended. awaiting-input: the agent shows a prompt or waits on the developer. */
  readonly kind: 'finished' | 'awaiting-input';
  /** The prompt's type, for awaiting-input. */
  readonly notificationType?: NotificationType;
  /** The turn's final reply, redacted and bounded; null when the agent reported none. */
  readonly completionReport: CompletionReport | null;
  /** Few-word synopsis of that reply; null when unknown. */
  readonly completionSummary: string | null;
  readonly requestedAt: number;
  /** Acknowledge (`ack`) before this, or main falls back. */
  readonly ackBy: number;
  /** Decide (`resolve`) before this, or main falls back. */
  readonly decideBy: number;
};

export type ConductorDecisionCloseReason =
  /** The conductor's decision was applied. */
  | 'resolved'
  /** The agent moved on (a new turn, prompt or error) or the session ended: nothing to decide. */
  | 'superseded'
  /** No decision in time: main fell back. */
  | 'timed-out'
  /** Main fell back for another reason: no acknowledgement, claim lapsed, the conductor asked. */
  | 'fallback';

export type ConductorDecisionEvent =
  | ({ readonly type: 'requested' } & ConductorDecisionRequest)
  | {
      readonly type: 'closed';
      readonly holdId: string;
      readonly conversationId: string;
      readonly reason: ConductorDecisionCloseReason;
    };

/**
 * What `resolve` did: applied it; took it after main had already fallen back (it may still
 * correct the indicator); or ignored it (no such hold, or the agent moved on).
 */
export type ConductorDecisionOutcome = 'decision' | 'late' | 'stale';

/** The conductor's mark on a published status: present when its decision set that status. */
export type ConductorDecisionMark = {
  readonly state: 'needs_you' | 'done' | 'quiet';
  readonly headline?: string;
  readonly detail?: string;
  /** Whether a notification went out for it. */
  readonly notify: boolean;
};

/** What the conductor slice calls on main's gate (wire procedures forward here). */
export interface ConductorDecisionHost {
  /** Replaces the set of conversations whose conductor decides. Renew within the TTL. */
  claim(conversationIds: readonly string[]): { ttlMs: number };
  /** The renderer has the request and a conductor is working on it. */
  ack(holdId: string): void;
  resolve(
    holdId: string,
    conversationId: string,
    decision: ConductorDecision
  ): ConductorDecisionOutcome;
  /** Requests still open, for a renderer that (re)attaches. */
  open(): ConductorDecisionRequest[];
}

/** What main's gate asks of the conductor slice. */
export interface ConductorDecisionPolicy {
  /** The setting is on, a key is set, and the budget has room. Cheap; called per event. */
  enabled(): Promise<boolean>;
  /** Delivers an event to the renderer. */
  emit(event: ConductorDecisionEvent): void;
}

let host: ConductorDecisionHost | null = null;
let policy: ConductorDecisionPolicy | null = null;

export function setConductorDecisionHost(next: ConductorDecisionHost | null): void {
  host = next;
}

export function getConductorDecisionHost(): ConductorDecisionHost | null {
  return host;
}

export function setConductorDecisionPolicy(next: ConductorDecisionPolicy | null): void {
  policy = next;
}

export function getConductorDecisionPolicy(): ConductorDecisionPolicy | null {
  return policy;
}
