/**
 * Recognising Claude Code's own "usage limit reached" message in what a session last said.
 *
 * The prefixes are copied from `USAGE_LIMIT_ERROR_PREFIXES` in `@anthropic-ai/claude-agent-sdk`
 * (0.3.274, `sdk.d.ts`), documented there as "messages meaning a usage limit was genuinely
 * reached": the exact text the CLI writes as its synthetic reply when an account runs out
 * (for example "You've hit your limit · resets 5pm (Europe/Berlin)"). The ACP adapter
 * (`@agentclientprotocol/claude-agent-acp`, `isSyntheticUsageLimitMessage`) matches on the same
 * list. Warnings ("You've used 90% …") and overage transitions ("You're now using extra usage")
 * use other prefixes and never end a turn, so they are deliberately not here.
 */
export const CLAUDE_USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/** How much of a terminal's retained output is read: the end of it, where the turn ended. */
const TERMINAL_TAIL_CHARS = 16_000;
/** Lines of that tail searched: the limit message sits above the input box and status line. */
const TERMINAL_TAIL_LINES = 40;
/** Lines at the end of a reply searched: the message can be followed by an upgrade hint. */
const REPLY_TAIL_LINES = 3;

/** The usage-limit line of a turn's final reply, or null. Only the last lines count. */
export function usageLimitLineInReply(text: string | null | undefined): string | null {
  if (!text) return null;
  return findLimitLine(lastLines(text, REPLY_TAIL_LINES));
}

/**
 * The usage-limit line near the end of a terminal's output, or null. The output is raw: escape
 * sequences are removed first, and cursor movements count as line breaks, since a terminal UI
 * redraws lines in place rather than writing newlines.
 */
export function usageLimitLineInTerminal(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const plain = stripTerminalControls(raw.slice(-TERMINAL_TAIL_CHARS));
  return findLimitLine(lastLines(plain, TERMINAL_TAIL_LINES));
}

function findLimitLine(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    // Box-drawing, bullets and other decoration come before the words.
    const line = normalizeApostrophes(lines[index]!)
      .replace(/^[^\p{L}]+/u, '')
      .trim();
    if (CLAUDE_USAGE_LIMIT_PREFIXES.some((prefix) => line.startsWith(prefix))) return line;
  }
  return null;
}

function lastLines(text: string, count: number): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count);
}

function normalizeApostrophes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

/** Cursor movement and erasing: CSI sequences ending in one of these act as a line break. */
const CURSOR_MOVES = 'ABCDEFGHJKdf';

function stripTerminalControls(text: string): string {
  return (
    text
      // OSC (titles, hyperlinks): ESC ] … BEL or ESC \
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // CSI: ESC [ params final
      .replace(/\u001b\[[0-?]*[ -/]*([@-~])/g, (_match, final: string) =>
        CURSOR_MOVES.includes(final) ? '\n' : ''
      )
      // Other two-character escapes.
      .replace(/\u001b[@-Z\\-_]/g, '')
      // Remaining C0 controls except tab and line breaks.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
}
