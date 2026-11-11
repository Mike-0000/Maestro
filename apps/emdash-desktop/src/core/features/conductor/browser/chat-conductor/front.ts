import { parseCommand } from '../../api/grammar';
import { isPureStop } from '../../api/stop-words';

/**
 * What the HUD's routing needs of a chat conductor: a developer message, and the composer's
 * unsent text. `ChatConductorSession` is one; tests use fakes.
 */
export interface FrontConductorSession {
  readonly draft: string;
  /** A turn is running or waiting to run. */
  readonly busy: boolean;
  send(text: string): void;
  setDraft(text: string): void;
  /** Ends the running turn at its next step. */
  stop(): void;
}

/**
 * The chat conductor whose view the developer is looking at: words from the HUD go to it instead
 * of to Maestro. How sessions are keyed (a chat, a task) is the manager's business, not the HUD's.
 */
export interface FrontConductor {
  readonly session: FrontConductorSession;
  /** What it conducts, as the developer knows it ("Atlas"). */
  readonly name: string;
}

export interface FrontConductorSource {
  /** Null when no Conductor view is on screen, or chat conductors cannot run. */
  readonly front: FrontConductor | null;
}

/** How the HUD names the chat conductor it addresses. */
export function conductorLabel(front: FrontConductor): string {
  return `${front.name}'s conductor`;
}

/** What Maestro is waiting on right now, as far as words that may be answers are concerned. */
export type MaestroFloor = {
  /** A confirmation is on screen, waiting for a yes or a no. */
  readonly pending: boolean;
  /** A Maestro turn is running: a stop stops it. */
  readonly busy: boolean;
  /** Maestro just asked the developer which one they meant. */
  readonly clarifying: boolean;
};

/**
 * True when words the developer addressed to a chat conductor must still reach Maestro, because
 * they answer what Maestro has open right now: its question of a moment ago (a clarification), a
 * yes, no or "close" to the confirmation on screen, or a stop while it works or waits. Anything
 * else goes to the chat conductor, and what Maestro has open keeps waiting (a confirmation then
 * lapses on its own clock, as it does when nobody answers).
 */
export function answersMaestro(text: string, floor: MaestroFloor): boolean {
  if (floor.clarifying) return true;
  if ((floor.pending || floor.busy) && isPureStop(text)) return true;
  if (!floor.pending) return false;
  const command = parseCommand(text, [], null);
  return (
    command?.kind === 'confirm' ||
    command?.kind === 'reject' ||
    (command?.kind === 'close' && command.agent === null)
  );
}

/** "send it", "submit", "press enter": what sends dictated words that are waiting. */
export function isSubmitPhrase(text: string): boolean {
  return parseCommand(text, [], null)?.kind === 'submit';
}

/** Dictated words added after what the composer already holds. */
export function joinDraft(base: string, text: string): string {
  const head = base.trimEnd();
  const tail = text.trim();
  if (!head) return tail;
  if (!tail) return base;
  return `${head} ${tail}`;
}
