/**
 * Characters of terminal output the renderer received per session since the last take, so the
 * stall log can name the sessions that were streaming when the window froze.
 */
const tally = new Map<string, number>();

export type TerminalOutputTallyEntry = { label: string; chars: number };

export function noteTerminalOutput(label: string, chars: number): void {
  tally.set(label, (tally.get(label) ?? 0) + chars);
}

/** The tally since the last take, largest first, and starts a new one. */
export function takeTerminalOutputTally(): TerminalOutputTallyEntry[] {
  const entries = [...tally].map(([label, chars]) => ({ label, chars }));
  tally.clear();
  return entries.sort((a, b) => b.chars - a.chars);
}
