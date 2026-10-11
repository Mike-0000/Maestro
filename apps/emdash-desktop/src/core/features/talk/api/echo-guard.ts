/**
 * Tells Maestro's own voice, picked up by the microphone, from the developer. Echo cancellation
 * does most of this; the guard catches what gets through, so a sentence Maestro said in the
 * last few seconds (with the line's voice, or with a local one the conductor reported) is not
 * taken as something said to it. A word that stops things is the exception: see `neverEcho`.
 */

export type Spoken = { readonly text: string; readonly at: number };

/** Speech is only compared with what was said this recently. */
export const ECHO_WINDOW_MS = 12_000;
/** The share of the heard words that must appear, in order, in what was said. */
const ECHO_SHARE = 0.8;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Length of the longest run of `heard` words found in order (gaps allowed) in `said`. */
function inOrder(heard: readonly string[], said: readonly string[]): number {
  let previous = new Array<number>(said.length + 1).fill(0);
  for (const word of heard) {
    const row = new Array<number>(said.length + 1).fill(0);
    for (let index = 1; index <= said.length; index++) {
      row[index] =
        said[index - 1] === word
          ? (previous[index - 1] ?? 0) + 1
          : Math.max(previous[index] ?? 0, row[index - 1] ?? 0);
    }
    previous = row;
  }
  return previous[said.length] ?? 0;
}

function contains(said: readonly string[], heard: readonly string[]): boolean {
  for (let start = 0; start + heard.length <= said.length; start++) {
    if (heard.every((word, offset) => said[start + offset] === word)) return true;
  }
  return false;
}

/**
 * True when `heard` is, nearly word for word, a stretch of something Maestro said in the last
 * few seconds. One or two words must match a stretch exactly: "yes" is far too common to call an
 * echo on a partial match.
 */
export function isEcho(heard: string, spoken: readonly Spoken[], now: number): boolean {
  const heardWords = words(heard);
  if (heardWords.length === 0) return false;
  for (const entry of spoken) {
    if (now - entry.at > ECHO_WINDOW_MS) continue;
    const said = words(entry.text);
    if (said.length === 0) continue;
    if (heardWords.length <= 2) {
      if (contains(said, heardWords)) return true;
      continue;
    }
    if (inOrder(heardWords, said) / heardWords.length >= ECHO_SHARE) return true;
  }
  return false;
}

const STOP_WORDS =
  /^(?:no|nope|nah|stop|wait|cancel|abort|hold on|never ?mind|don't|do not)(?: (?:no|stop|wait|it|that|please))*$/;

/**
 * True for "no", "stop", "wait" and their like. These are never dropped as an echo, even right
 * after Maestro said the same word: taking an echo for a stop costs the developer a repeat,
 * and taking a stop for an echo lets something run that they tried to prevent.
 */
export function neverEcho(heard: string): boolean {
  return STOP_WORDS.test(words(heard).join(' '));
}

/** Drops what was said too long ago to be an echo now. */
export function recentSpoken(spoken: readonly Spoken[], now: number): Spoken[] {
  return spoken.filter((entry) => now - entry.at <= ECHO_WINDOW_MS);
}
