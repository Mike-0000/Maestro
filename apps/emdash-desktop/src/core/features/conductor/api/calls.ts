/**
 * Calls: how agents reach the developer one at a time. A finished agent, a question, or a
 * permission prompt is delivered as a call from exactly one agent. While the call is "on the
 * line" the developer can pick it up (one tap of the talk key, a held key, a click), and what
 * they say next is bound to that caller without naming it.
 *
 * Which call comes next, and who it is from, is decided here by code. An agent chooses when a
 * call is offered; it never chooses who the developer's words go to.
 */

export type CallKind =
  /** An agent finished its turn and reported something. */
  | 'completion'
  /** An agent asked the developer a question (an `ask_developer` request). */
  | 'question'
  /** An agent's request the conductor put to the developer for a yes or no. */
  | 'request'
  /** An agent is waiting on a permission prompt in its terminal. */
  | 'permission'
  /** An agent needs the developer for another reason (waiting for input, stopped on an error). */
  | 'attention';

export type Call = {
  readonly id: string;
  readonly conversationId: string;
  readonly agentName: string;
  readonly kind: CallKind;
  /** What Maestro says to deliver the call. */
  readonly text: string;
  /** 0 to 1; the most urgent waiting call is delivered first. */
  readonly urgency: number;
  readonly at: number;
  /** The agent request this call is about, when there is one. */
  readonly requestId?: string;
  /** For a permission call: what the prompt on screen looked like when it was read out. */
  readonly fingerprint?: string;
  /** The trace id of the turn that produced the call's text, if a turn did. */
  readonly interactionId?: string;
  /** Set aside with "later": not delivered before this time unless the developer asks. */
  readonly notBefore?: number;
};

/** off: announcements as before. quiet: calls are shown, not spoken. spoken: read aloud. */
export const callModes = ['off', 'quiet', 'spoken'] as const;
export type CallMode = (typeof callModes)[number];

/** How long a call stays on the line after Maestro stops speaking. */
export const DEFAULT_CALL_WINDOW_SEC = 6;
/** How long a call set aside with "later" stays away, unless the developer asks for it. */
export const LATER_MS = 120_000;
/** More spoken calls than this from one agent inside a minute are shown instead of spoken. */
export const SPOKEN_CALLS_PER_MINUTE = 4;

const BASE_URGENCY: Record<CallKind, number> = {
  permission: 0.8,
  question: 0.7,
  request: 0.6,
  attention: 0.5,
  completion: 0.4,
};

/** A call's urgency: Jev's triage reading when there is one, else a default for its kind. */
export function callUrgency(kind: CallKind, triage?: number | null): number {
  if (typeof triage === 'number' && Number.isFinite(triage)) {
    return Math.min(1, Math.max(0, triage));
  }
  return BASE_URGENCY[kind];
}

/**
 * The call to deliver next: the agent the developer asked to stay with first, then the most
 * urgent, then the one that has waited longest.
 */
export function nextCall(
  waiting: readonly Call[],
  stayWith: string | null = null,
  now: number = Number.POSITIVE_INFINITY
): Call | null {
  let best: Call | null = null;
  for (const call of waiting) {
    // Set aside, and its time has not come.
    if ((call.notBefore ?? 0) > now) continue;
    if (!best) {
      best = call;
      continue;
    }
    const sticky = stayWith !== null && call.conversationId === stayWith;
    const bestSticky = stayWith !== null && best.conversationId === stayWith;
    if (sticky !== bestSticky) {
      if (sticky) best = call;
      continue;
    }
    if (call.urgency > best.urgency || (call.urgency === best.urgency && call.at < best.at)) {
      best = call;
    }
  }
  return best;
}

/** True when `agent` has had its share of spoken calls for the minute ending at `now`. */
export function overSpokenLimit(spokenAt: readonly number[], now: number): boolean {
  return spokenAt.filter((at) => now - at < 60_000).length >= SPOKEN_CALLS_PER_MINUTE;
}

/** What reading an agent's output returns when there is nothing to read (see `readAgentOutput`). */
const NOTHING_TO_READ =
  /^\((?:no terminal session|no output yet|the chat transcript is not available)\)$/;
/**
 * A status line: its timers and counters change while the prompt above it stays the same. Only
 * the hint every agent's working line carries marks one. A looser test ("tokens", "elapsed")
 * would also drop a line of the command being asked about, and hide a change in it.
 */
const STATUS_LINE = /esc to interrupt/i;
/** A line that opens with a spinner is a status line as well. */
const SPINNER_LINE = /^\s*[⠀-⣿✢✳✶✻✽]/;

/**
 * What a permission prompt looked like, reduced to something that survives a redraw: chrome
 * and spacing are dropped, and so is a whole status or spinner line, whose timers and counters
 * change while the prompt stays the same. Every other line that was read counts, in full,
 * digits included: `releases/v1` and `releases/v2` are different prompts, and so are two long
 * commands that differ in their first line. Two readings that differ mean the agent is asking
 * something else now. Null when there was nothing to read, which matches nothing: an unread
 * prompt cannot be agreed to.
 */
export function promptFingerprint(terminalTail: string): string | null {
  if (NOTHING_TO_READ.test(terminalTail.trim())) return null;
  const lines = terminalTail
    .split('\n')
    .filter((line) => !SPINNER_LINE.test(line) && !STATUS_LINE.test(line))
    .map((line) =>
      line
        // Box drawing, block elements, braille spinners and similar chrome.
        .replace(/[─-▟⠀-⣿■-◿←-⇿]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    )
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** What the developer says to steer the calls, as the grammar reads it. */
export type CallSteer = 'skip' | 'next' | 'later' | 'hold' | 'resume' | 'stay' | 'back';
