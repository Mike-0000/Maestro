import type { BrowserImage } from '@core/primitives/browser/api';

/**
 * The seam between the conductor and the realtime voice line. While the line is open its model
 * is the conductor: it hears the developer, decides, and calls the conductor's tools. The
 * conductor store still runs every tool, behind the same confirmations as always, and falls
 * back to the text model when the line is not open.
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
  'find_in_project',
  'review_instructions',
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

/** How much of what the conductor wrote to an agent on its own a note keeps. */
const NOTE_MESSAGE_CHARS = 300;

/** True for what Maestro started by itself: an agent's request, a finished agent's report. */
function isEvent(said: string): boolean {
  return /^\[(?:request|completion)\b/.test(said);
}

/**
 * A turn the line's model did not run (a fast command, an agent's request the text model
 * decided, a finished agent's report), as that model is told it: what started it, what was done,
 * and what the developer was told. The developer may ask the line about any of it. `told` is
 * false when the reply already reached the line some other way. Null when there is nothing to
 * tell.
 */
export function lineEventNote(turn: {
  readonly said: string;
  /** What started the turn, when it was not the developer, in place of `said`. */
  readonly about?: string;
  readonly actions: readonly (LineAction & { readonly input?: unknown })[];
  readonly reply: string;
  readonly told?: boolean;
}): string | null {
  const event = Boolean(turn.about) || isEvent(turn.said);
  const did = turn.actions
    .filter((action) => !LINE_READ_TOOLS.has(action.tool))
    .map((action) => {
      const outcome = clip(action.outcome, RECORD_OUTCOME_CHARS);
      // The conductor's own answer to an agent is what "what did you tell it?" asks for.
      const message =
        action.tool === 'answer_request' ? stringInput(action.input, 'message') : undefined;
      const wrote = message ? ` It wrote: “${clip(message, NOTE_MESSAGE_CHARS)}”` : '';
      return `${action.tool}${action.status ? ` (${action.status})` : ''}: ${outcome}${wrote}`;
    });
  const reply = turn.told === false ? '' : clip(turn.reply, RECORD_REPLY_CHARS);
  if (did.length === 0 && !reply && !event) return null;
  const said = clip(turn.about ?? turn.said, RECORD_ASKED_CHARS);
  return [
    '[Conductor] Handled without you:',
    event ? `${said}.` : `the developer said “${said}”.`,
    ...(did.length > 0 ? [`Done: ${did.join('; ')}.`] : []),
    ...(reply ? [`Maestro said: “${reply}”`] : []),
    ...(event && did.length === 0 && !reply ? ['Nothing was done.'] : []),
  ].join(' ');
}

function stringInput(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The field of each tool's input that is written for an agent to read. */
const BRIEF_FIELDS: Readonly<Record<string, string>> = {
  send_to_agent: 'text',
  spawn_agent: 'prompt',
};

/**
 * For the diagnostics: how many words the developer said and how many the model wrote for the
 * agent. A message much longer than what was said carries things the developer did not say.
 */
export function briefSize(
  tool: string,
  input: unknown,
  asked: string
): { askedWords: number; writtenWords: number } | Record<string, never> {
  const field = BRIEF_FIELDS[tool];
  const written = field ? (input as Record<string, unknown> | null)?.[field] : undefined;
  if (typeof written !== 'string') return {};
  return { askedWords: wordCount(asked), writtenWords: wordCount(written) };
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
  /** How many times the model was asked: one, plus one for each batch of tool results. */
  readonly rounds?: number;
  /** Words it said in a response that also called a tool: said before any result was in. */
  readonly leadWords?: number;
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
