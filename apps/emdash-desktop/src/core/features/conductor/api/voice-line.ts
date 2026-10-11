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
   * A local voice (a read-back, a reply, an announcement) is about to say `text`: should the
   * line's microphone pick it up, it is Maestro's own sentence, not the developer's.
   */
  spoke(text: string): void;
}
