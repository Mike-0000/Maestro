import type { ConductorToolName } from './tools';

/**
 * The seam between the conductor and the talk line (a realtime voice session). The line's model
 * listens and speaks; it can look at state and nothing else. Everything that changes something
 * stays with the conductor, behind the gates it already has.
 */

/**
 * The only conductor tools the voice model may call. Each one reads. None focuses a window,
 * moves the camera, or records who was last addressed, so nothing the voice does (or is talked
 * into doing by text it read) can change where the developer's next words go.
 */
export const VOICE_READ_TOOLS: readonly ConductorToolName[] = [
  'read_agent',
  'agent_details',
  'recent_activity',
  'find_conversations',
  'describe_canvas',
];

export function isVoiceReadTool(name: string): name is ConductorToolName {
  return (VOICE_READ_TOOLS as readonly string[]).includes(name);
}

/** How much of one read reaches the voice model. */
export const VOICE_READ_MAX_CHARS = 6_000;

/**
 * The voice model's way to say "this needs the conductor". It carries no content: the conductor
 * is handed the developer's own latest words, never text the voice model wrote.
 */
export const VOICE_HAND_OFF_TOOL = 'hand_off';

/** One agent as the line's state feed describes it. */
export type LineAgent = {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly project: string;
  readonly status: string;
};

/** What the line heard with no key pressed, and what may become of it. */
export type LineHearing =
  /** It steered the calls or cancelled something; nothing more to do. */
  | 'handled'
  /** A question or remark: the voice may answer it. */
  | 'talk'
  /** A command. Nothing runs without a key, so the developer is told to press one. */
  | 'needs-key';

/** What the conductor asks of an open line. */
export interface ConductorTalkLine {
  /** True when the line can take a turn right now. */
  ready(): boolean;
  /** Answers the developer's words by voice. Resolves false when the line could not take them. */
  answer(text: string): Promise<boolean>;
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
