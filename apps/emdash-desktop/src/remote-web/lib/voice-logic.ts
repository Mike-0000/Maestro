/** The decisions behind voice mode, kept free of the DOM so they can be tested directly. */

// ── Capture ──────────────────────────────────────────────────────────────────

/** `hold` ends when the press does; `tap` runs until it is finished or cancelled. */
export type CaptureMode = 'hold' | 'tap';
/** A `command` goes to the conductor; `dictation` becomes text in an agent's composer. */
export type CaptureIntent = 'command' | 'dictation';

export type CaptureState =
  | { phase: 'idle' }
  | {
      /** The microphone is being opened (this is where a permission prompt sits). */
      phase: 'starting';
      mode: CaptureMode;
      intent: CaptureIntent;
      /** What to do the moment it opens, when the user did not wait for it. */
      queued: 'finish' | 'cancel' | null;
    }
  | { phase: 'recording'; mode: CaptureMode; intent: CaptureIntent };

export type CaptureEvent =
  | { type: 'begin'; mode: CaptureMode; intent: CaptureIntent }
  /** The microphone is open and audio is arriving. */
  | { type: 'opened' }
  | { type: 'failed' }
  /**
   * A hold ended. `latch` says whether a press too short to be speech becomes tap-to-talk (a
   * finger on the mic button) or is dropped (a stray key press).
   */
  | { type: 'release'; heldMs: number; cancel: boolean; latch: boolean }
  /** Tapped again, pressed Send, or reached the time cap. */
  | { type: 'finish' }
  | { type: 'cancel' };

/** What the caller must do with the microphone after a transition. */
export type CaptureEffect = 'open' | 'finish' | 'discard' | null;

export const IDLE_CAPTURE: CaptureState = { phase: 'idle' };

/** A press shorter than this is a tap, not a held utterance. */
export const TAP_MAX_MS = 350;
/** Recordings shorter than this hold no speech worth sending. */
export const MIN_UTTERANCE_MS = 300;
/** A recording left open ends itself here, just under the host's upload limit. */
export const MAX_UTTERANCE_MS = 5 * 60_000;

export function reduceCapture(
  state: CaptureState,
  event: CaptureEvent
): { state: CaptureState; effect: CaptureEffect } {
  const stay = { state, effect: null } as const;
  if (state.phase === 'idle') {
    if (event.type !== 'begin') return stay;
    return {
      state: { phase: 'starting', mode: event.mode, intent: event.intent, queued: null },
      effect: 'open',
    };
  }

  // What the user asked for, independent of whether the microphone is open yet.
  let wish: 'finish' | 'cancel' | 'latch' | null = null;
  if (event.type === 'finish') wish = 'finish';
  else if (event.type === 'cancel') wish = 'cancel';
  else if (event.type === 'release' && state.mode === 'hold') {
    if (event.cancel) wish = 'cancel';
    else if (event.heldMs >= TAP_MAX_MS) wish = 'finish';
    else wish = event.latch ? 'latch' : 'cancel';
  }

  if (state.phase === 'starting') {
    if (event.type === 'failed') return { state: IDLE_CAPTURE, effect: null };
    if (event.type === 'opened') {
      if (state.queued === 'finish') return { state: IDLE_CAPTURE, effect: 'finish' };
      if (state.queued === 'cancel') return { state: IDLE_CAPTURE, effect: 'discard' };
      return {
        state: { phase: 'recording', mode: state.mode, intent: state.intent },
        effect: null,
      };
    }
    if (wish === 'latch') return { state: { ...state, mode: 'tap' }, effect: null };
    // A cancel is never overridden by a later finish.
    if (wish && state.queued !== 'cancel')
      return { state: { ...state, queued: wish }, effect: null };
    return stay;
  }

  if (wish === 'latch') return { state: { ...state, mode: 'tap' }, effect: null };
  if (wish === 'finish') return { state: IDLE_CAPTURE, effect: 'finish' };
  if (wish === 'cancel') return { state: IDLE_CAPTURE, effect: 'discard' };
  return stay;
}

/** `m:ss`, for the recording clock. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Adds dictated text to what is already in a text field, with a space where one is needed. */
export function appendDictation(existing: string, dictated: string): string {
  const text = dictated.trim();
  if (!text) return existing;
  if (!existing) return text;
  return /\s$/.test(existing) ? existing + text : `${existing} ${text}`;
}

// ── Replies ──────────────────────────────────────────────────────────────────

/** The reply this device has already accounted for; null before the first display arrives. */
export type ReplyCursor = { replyAt: number } | null;

export type ReplyContext = {
  /**
   * The link was just (re)established, so a changed reply may be one that was given while this
   * device was away rather than one given now.
   */
  settling: boolean;
  /** This device handed the conductor something and has not heard back yet. */
  awaiting: boolean;
};

/**
 * Decides whether a display update carries a reply that should be spoken. A reply is new when
 * its timestamp changes; the one already on the display at first load, and one that turned up
 * across a reconnect without this device asking for it, are shown but not read out.
 */
export function detectReply(
  cursor: ReplyCursor,
  hud: { reply: string; replyAt: number },
  context: ReplyContext
): { cursor: { replyAt: number }; fresh: boolean; speak: string | null } {
  const next = { replyAt: hud.replyAt };
  if (cursor === null || cursor.replyAt === hud.replyAt) {
    return { cursor: next, fresh: false, speak: null };
  }
  const text = hud.reply.trim();
  const speakable = text !== '' && (context.awaiting || !context.settling);
  return { cursor: next, fresh: true, speak: speakable ? text : null };
}

// ── Attention notices ────────────────────────────────────────────────────────

type AttentionAgent = {
  conversationId: string;
  taskName: string;
  needsAttention: boolean;
  archived: boolean;
};

/**
 * Agents that need a person now and did not at the previous look. The first look (`previous`
 * null) only sets the baseline: agents already waiting when the app opens are not announced.
 */
export function newlyNeedingAttention(
  previous: ReadonlySet<string> | null,
  agents: readonly AttentionAgent[]
): { waiting: Set<string>; names: string[] } {
  const waiting = new Set<string>();
  const names: string[] = [];
  for (const agent of agents) {
    if (!agent.needsAttention || agent.archived) continue;
    waiting.add(agent.conversationId);
    if (previous && !previous.has(agent.conversationId)) names.push(agent.taskName);
  }
  return { waiting, names };
}

/** "Fix auth needs you", "A and B need you", "A, B and 2 others need you". */
export function attentionSentence(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const [first, second, third] = unique;
  if (first === undefined) return '';
  if (second === undefined) return `${first} needs you`;
  if (third === undefined) return `${first} and ${second} need you`;
  if (unique.length === 3) return `${first}, ${second} and ${third} need you`;
  return `${first}, ${second} and ${unique.length - 2} others need you`;
}

export const ATTENTION_BATCH_MS = 1_000;

/** Collects agents that start waiting within a moment of each other into one sentence. */
export class AttentionBatcher {
  private names: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly announce: (sentence: string) => void,
    private readonly windowMs = ATTENTION_BATCH_MS
  ) {}

  add(names: readonly string[]): void {
    if (names.length === 0) return;
    this.names.push(...names);
    // The window opens with the first agent and is not extended by later ones.
    this.timer ??= setTimeout(() => this.flush(), this.windowMs);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.names = [];
  }

  private flush(): void {
    const sentence = attentionSentence(this.names);
    this.clear();
    if (sentence) this.announce(sentence);
  }
}

// ── Examples ─────────────────────────────────────────────────────────────────

/** A few things worth saying, phrased with the host's real agent and project names. */
export function examplePhrases(
  agentNames: readonly string[],
  projectNames: readonly string[]
): string[] {
  const [first, second] = agentNames;
  const project = projectNames[0];
  const phrases: string[] = [];
  if (first) phrases.push(`Tell ${first} to run the tests`);
  if (first) phrases.push(`What is ${second ?? first} doing`);
  if (project) phrases.push(`Start an agent in ${project}`);
  if (!first) phrases.push('Who needs me');
  if (phrases.length < 3) phrases.push('What can I say');
  return phrases.slice(0, 3);
}
