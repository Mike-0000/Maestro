import {
  developerTyping,
  type DeveloperTyping,
} from '@core/features/terminals/api/browser/pty/developer-typing';

/**
 * The conductor's messages to one agent's terminal, one at a time, never over the developer's
 * typing.
 *
 * A message pasted while the developer is typing in the same input merges with their half-typed
 * words into one prompt (Oct 18: Zulu got the developer's answer and the conductor's contradicting
 * one as a single message). So a message waits while they type there, and is typed only once they
 * have been quiet a while, or pressed Enter and paused. It never clears, edits or submits their
 * text: when text they have not sent stays in the input, the message waits, and after
 * `MAX_HOLD_MS` it is given up on, with an error the caller reports.
 *
 * Messages to one agent also go one at a time, each pasted and submitted on its own, so two that
 * were held together do not land in one prompt. Each one, held or not, is checked against the
 * agent's prompt right before it is typed: the message before it may have raised one, and Enter
 * would answer it. The developer's own words skip the queue and the hold (they are typing them),
 * but never type into a prompt either.
 */

/** Typing this recent in an agent's terminal holds a message to it; this much quiet releases it. */
export const TYPING_IDLE_MS = 15_000;
/** After the developer presses Enter, this much quiet releases a message. */
export const AFTER_SUBMIT_IDLE_MS = 3_000;
/** The longest a message waits. Matches how long a request reply waits for a prompt to clear. */
export const MAX_HOLD_MS = 10 * 60_000;
const HOLD_POLL_MS = 500;
/** Between two messages to one agent, so its input has cleared before the next paste lands. */
export const BETWEEN_MESSAGES_MS = 500;

/**
 * Why a message is waiting: the developer is typing there, left text unsent there, or (re-checked
 * after a wait) the agent now shows a prompt that typing would answer.
 */
export type HoldReason = 'typing' | 'unsent-text' | 'prompt';

export interface DeliveryHold {
  conversationId: string;
  reason: HoldReason;
  /** Messages to the same agent already waiting ahead of this one. 0: the first to wait. */
  waiting: number;
}

export type DeliveryEvent =
  | ({ type: 'held' } & DeliveryHold)
  | { type: 'released'; conversationId: string; heldMs: number }
  | { type: 'expired'; conversationId: string; reason: HoldReason; heldMs: number }
  | {
      type: 'submit';
      conversationId: string;
      providerId: string;
      /** Flat, so it can go into a trace event's `detail` as is. */
      detail: Record<string, string | number | boolean | null>;
    };

const listeners = new Set<(event: DeliveryEvent) => void>();

/** Listens to every delivery's holds and submit attempts. Returns the unsubscribe. */
export function onAgentDelivery(listener: (event: DeliveryEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitDelivery(event: DeliveryEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A listener's failure must not fail the delivery.
    }
  }
}

/** Why a message to an agent should wait, from what the developer typed there; null to send. */
export function typingHoldReason(typing: DeveloperTyping | null, now: number): HoldReason | null {
  if (!typing) return null;
  if (typing.lastKeystrokeAt !== null) {
    const quiet = typing.lastKeyWasSubmit ? AFTER_SUBMIT_IDLE_MS : TYPING_IDLE_MS;
    if (now - typing.lastKeystrokeAt < quiet) return 'typing';
  }
  return typing.unsentText ? 'unsent-text' : null;
}

/** A message waited `MAX_HOLD_MS` and was not typed, or (`waited` false) could not be typed now. */
export class DeliveryHeldError extends Error {
  constructor(
    readonly reason: HoldReason,
    agentName: string,
    waited = true
  ) {
    super(heldMessage(reason, agentName, waited));
    this.name = 'DeliveryHeldError';
  }
}

function heldMessage(reason: HoldReason, agentName: string, waited: boolean): string {
  if (reason === 'prompt') {
    return waited
      ? `${agentName} stayed at a prompt that needs you, so the message was not delivered.`
      : `${agentName} is at a prompt that needs you, so the message was not sent. Answer it first.`;
  }
  if (reason === 'unsent-text') {
    return `${agentName} has text you have not sent in its input, so the message was not delivered. Send or clear it, then try again.`;
  }
  return `You kept typing in ${agentName}, so the message was not delivered.`;
}

interface Lane {
  /** The queued messages, in order; each one's hold and write. */
  tail: Promise<void>;
  /** Writes to the input (a message's paste and Enter, or dictation), one at a time. */
  writes: Promise<void>;
  queued: number;
  active: number;
  /** Why the message at the front waits; null when it does not. */
  holding: HoldReason | null;
  lastWriteAt: number;
}

const lanes = new Map<string, Lane>();

function laneFor(conversationId: string): Lane {
  let lane = lanes.get(conversationId);
  if (!lane) {
    lane = {
      tail: Promise.resolve(),
      writes: Promise.resolve(),
      queued: 0,
      active: 0,
      holding: null,
      lastWriteAt: Number.NEGATIVE_INFINITY,
    };
    lanes.set(conversationId, lane);
  }
  lane.active += 1;
  return lane;
}

function leave(conversationId: string, lane: Lane): void {
  lane.active -= 1;
  if (lane.active === 0 && lanes.get(conversationId) === lane) lanes.delete(conversationId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a locked write returns when it found a reason not to type after all. */
const NOT_NOW = Symbol('not-now');

/**
 * Runs `write` once no other write to this agent's input is in progress, and not sooner than
 * `BETWEEN_MESSAGES_MS` after the last one ended, so the agent has taken that one in first.
 */
function locked<T>(lane: Lane, write: () => Promise<T>): Promise<T> {
  const run = lane.writes.then(async () => {
    const gap = lane.lastWriteAt + BETWEEN_MESSAGES_MS - Date.now();
    if (gap > 0) await sleep(gap);
    return write();
  });
  const wrote = (result: unknown) => {
    if (result !== NOT_NOW) lane.lastWriteAt = Date.now();
  };
  lane.writes = run.then(wrote, () => wrote(undefined));
  return run;
}

/**
 * Typing into an agent's input that is not a message of its own (dictated words, typed without
 * Enter): it skips the queue and the hold, and only waits for a write already in progress, so it
 * cannot land between a message's paste and its Enter.
 */
export async function writeToInput<T>(conversationId: string, write: () => Promise<T>): Promise<T> {
  const lane = laneFor(conversationId);
  try {
    return await locked(lane, write);
  } finally {
    leave(conversationId, lane);
  }
}

export interface QueueOptions {
  /** The agent's name for a give-up error. */
  agentName: string;
  /**
   * False for the developer's own words: they skip the queue and the typing hold, and go ahead
   * of held messages, which stay held. They still never type into a prompt (see `blockedNow`).
   */
  waitForTyping?: boolean;
  /** Told once, as soon as this message is held, so the caller need not wait to say so. */
  onHold?: (hold: DeliveryHold) => void;
  /**
   * Checked right before every write, under the write lock: a reason the message must not be
   * typed now even though the developer is not typing (the agent shows a prompt, perhaps raised
   * by the message before this one). Null to go ahead.
   */
  blockedNow?: () => HoldReason | null;
}

/** The developer's own message: the next write, unless typing now would answer a prompt. */
async function sendNow<T>(
  conversationId: string,
  write: () => Promise<T>,
  options: QueueOptions
): Promise<T> {
  const lane = laneFor(conversationId);
  try {
    return await locked(lane, async () => {
      const blocked = options.blockedNow?.();
      if (blocked) throw new DeliveryHeldError(blocked, options.agentName, false);
      return write();
    });
  } finally {
    leave(conversationId, lane);
  }
}

/**
 * Queues one message to an agent: it waits for the developer's typing and for any prompt to
 * clear (see the file comment), then runs `write` (the paste and its Enter) after the messages
 * queued before it.
 */
export function queueDelivery<T>(
  conversationId: string,
  write: () => Promise<T>,
  options: QueueOptions
): Promise<T> {
  if (options.waitForTyping === false) return sendNow(conversationId, write, options);
  const lane = laneFor(conversationId);
  const queuedAt = Date.now();
  const waiting = lane.queued;
  lane.queued += 1;
  let held = false;
  const hold = (reason: HoldReason) => {
    lane.holding = reason;
    if (held) return;
    held = true;
    const event: DeliveryHold = { conversationId, reason, waiting };
    emitDelivery({ type: 'held', ...event });
    options.onHold?.(event);
  };
  const reasonNow = (): HoldReason | null =>
    typingHoldReason(developerTyping(conversationId), Date.now()) ?? options.blockedNow?.() ?? null;
  // Behind a held message this one is held as well; say so now, not once it reaches the front.
  const reasonAtQueue = reasonNow() ?? lane.holding;
  if (reasonAtQueue) hold(reasonAtQueue);

  const run = lane.tail.then(async (): Promise<T> => {
    for (;;) {
      for (let reason = reasonNow(); reason; reason = reasonNow()) {
        hold(reason);
        const heldMs = Date.now() - queuedAt;
        if (heldMs >= MAX_HOLD_MS) {
          lane.holding = null;
          emitDelivery({ type: 'expired', conversationId, reason, heldMs });
          throw new DeliveryHeldError(reason, options.agentName);
        }
        await sleep(HOLD_POLL_MS);
      }
      // Checked again under the lock, last thing before typing: the developer's latest keys and
      // a prompt the previous message raised both count.
      const result = await locked(lane, async () => {
        if (reasonNow()) return NOT_NOW;
        lane.holding = null;
        if (held) emitDelivery({ type: 'released', conversationId, heldMs: Date.now() - queuedAt });
        return write();
      });
      if (result !== NOT_NOW) return result;
    }
  });
  lane.tail = run.then(
    () => {},
    () => {}
  );
  return run.finally(() => {
    lane.queued -= 1;
    leave(conversationId, lane);
  });
}
