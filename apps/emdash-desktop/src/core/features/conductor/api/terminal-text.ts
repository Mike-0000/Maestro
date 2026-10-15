/**
 * Terminal output as the conductor's model reads it. A terminal pads every row to its width and
 * draws art (Codex's start screen is a braille logo), and a padded tail once filled a single turn
 * with tens of thousands of tokens of spaces. Only the words are kept.
 */

/** Rows drawn only of braille, box-drawing, or block characters: art and rules, never words. */
const DRAWING_ROW = /^[\s\u2500-\u259f\u2800-\u28ff]+$/u;
/** A letter or a digit: output without one has nothing to read. */
const MIN_READABLE = /[\p{L}\p{N}]/u;

export function cleanTerminalOutput(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => !DRAWING_ROW.test(line) || line === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when cleaned output has no words in it at all (an empty screen, only a logo). */
export function hasReadableOutput(cleaned: string): boolean {
  return MIN_READABLE.test(cleaned);
}
