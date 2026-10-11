import type { BrowserImage } from '@core/primitives/browser/api';

/**
 * The seam between the conductor and the realtime voice line. While the line is open its model
 * is the conductor: it hears the developer, decides, and calls the conductor's tools. The
 * conductor store still runs every tool, behind the same cancel windows and confirmations as
 * always, and falls back to the text model when the line is not open.
 */

/** How much of one tool result reaches the voice model. */
export const LINE_TOOL_MAX_CHARS = 6_000;

/**
 * Tools the line's model may run before the developer's words have been transcribed: they only
 * read. Every other tool waits for the transcript, because a confirmation rule, a name check,
 * a plan's approval, or the verbatim copy of a long request goes by those words.
 */
const LINE_INSTANT_TOOLS: ReadonlySet<string> = new Set([
  'list_agents',
  'read_agent',
  'agent_details',
  'recent_activity',
  'find_conversations',
  'describe_canvas',
  'delivery_status',
  'check_conflicts',
  'look_at_app',
  'investigate',
]);

export function isLineInstantTool(name: string): boolean {
  return LINE_INSTANT_TOOLS.has(name);
}

/** Tools that change nothing, whether or not they wait for the transcript. */
const LINE_READ_TOOLS: ReadonlySet<string> = new Set([...LINE_INSTANT_TOOLS, 'read_clipboard']);

/** One thing a turn did, as the turn log keeps it. */
type LineAction = {
  readonly tool: string;
  readonly outcome: string;
  readonly status?: 'failed' | 'cancelled';
};

/** How much of the developer's words, and of the answer, a turn's record keeps. */
const RECORD_ASKED_CHARS = 400;
const RECORD_REPLY_CHARS = 300;
const RECORD_OUTCOME_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * True when a turn changed something: an agent was started or told something, the canvas moved.
 * The exchange that led to it is then over. A turn that only read or answered leaves it open:
 * the developer may still be answering a question, or adding to what they said.
 */
export function lineTurnActed(actions: readonly LineAction[]): boolean {
  return actions.some((action) => !action.status && !LINE_READ_TOOLS.has(action.tool));
}

/**
 * A finished turn in one line, which takes the turn's place in the line's conversation: what the
 * developer asked, what was done about it, and what they were told. It names each tool by its
 * result and never by its input, so the text of a brief that was delivered is not kept where a
 * later brief could pick it up; the activity in the state has that text when it is asked for.
 */
export function lineRecord(turn: {
  readonly asked: string;
  readonly actions: readonly LineAction[];
  readonly reply: string;
}): string {
  const asked = clip(turn.asked, RECORD_ASKED_CHARS);
  const reply = clip(turn.reply, RECORD_REPLY_CHARS);
  const did = turn.actions
    .filter((action) => !LINE_READ_TOOLS.has(action.tool))
    .map((action) => {
      const outcome = clip(action.outcome, RECORD_OUTCOME_CHARS);
      return `${action.tool}${action.status ? ` (${action.status})` : ''}: ${outcome}`;
    });
  return [
    '[Conductor] Earlier, and over:',
    asked ? `the developer said “${asked}”.` : 'the developer spoke.',
    ...(did.length > 0 ? [`Done: ${did.join('; ')}.`] : []),
    ...(reply ? [`You answered: “${reply}”`] : []),
  ].join(' ');
}

/** One turn the conductor asks the line to take. */
export type LineTurnInput = {
  /** The developer's words when they were typed or transcribed here; absent when the line heard them. */
  readonly text?: string;
  /** Everything the conductor knows right now. It replaces what the line was told before. */
  readonly context: string;
  /** Answer aloud. Off, the answer is text only (typed words, or Maestro is muted). */
  readonly spoken: boolean;
};

export type LineTurnResult = {
  /** What the model answered, as text. */
  readonly reply: string;
  /** False when the turn was stopped, dropped, or cut off. */
  readonly completed: boolean;
  readonly tokens: number;
};

/** A tool's result as the line hands it to its model. */
export type LineToolResult = {
  readonly output: string;
  readonly images?: readonly BrowserImage[];
};

/** Words the line heard itself and is about to answer. */
export type LineSpeech = {
  readonly interactionId: string;
  /** When the developer began to speak. */
  readonly saidAt: number;
  /** The transcript, once the provider has written all of it; '' when it could not. */
  readonly heard: Promise<string>;
  /** The turn could not run: the model must not hear these words later. */
  discard(): void;
};

/** What the conductor asks of an open line. */
export interface ConductorTalkLine {
  /** True when the line can take a turn right now. */
  ready(): boolean;
  /**
   * Runs one turn: the model answers, calling tools through the conductor until it is done.
   * Resolves null when the line could not take the turn, and the caller handles it another way.
   */
  turn(input: LineTurnInput): Promise<LineTurnResult | null>;
  /** Stops the turn in progress and whatever the voice is saying. */
  stop(): void;
  /**
   * Says a sentence as written, and resolves once it has been said (true) or could not be
   * (false, and the caller speaks it some other way).
   */
  say(text: string): Promise<boolean>;
  /** Tells the voice model something happened, without making it speak. */
  note(text: string): void;
  /**
   * Says what the turn that just ended came to, in one line (see `lineRecord`). The turn stays
   * in the conversation as it happened while its exchange is open. `over` says the exchange is
   * finished: every turn of it is then replaced by its line, so that what the model sees as it
   * was said is only what the developer still wants, and what was done reads as done.
   */
  record(text: string, over: boolean): void;
  /**
   * A local voice (a read-back, a reply, an announcement) is about to say `text`: should the
   * line's microphone pick it up, it is Maestro's own sentence, not the developer's.
   */
  spoke(text: string): void;
}
