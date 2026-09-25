import type { Terminal } from '@xterm/xterm';

export const PREVIEW_MAX_ROWS = 40;

/** Reads the bottom `rows` lines of the terminal's active buffer as plain text. */
export function readTerminalTail(terminal: Terminal, rows: number): string[] {
  const buffer = terminal.buffer.active;
  const end = buffer.baseY + terminal.rows;
  const start = Math.max(0, end - rows);
  const lines: string[] = [];
  for (let index = start; index < end; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  return lines;
}

/**
 * Last `rows` printable lines from a retained PTY log snapshot. Used for canvas
 * preview so overview tiles do not have to connect an xterm.
 */
export function readOutputLogTail(text: string, rows: number = PREVIEW_MAX_ROWS): string[] {
  const stripped = stripAnsi(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = stripped.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - rows));
  while (tail.length > 0 && tail[0]?.trim() === '') tail.shift();
  while (tail.length > 0 && tail[tail.length - 1]?.trim() === '') tail.pop();
  return tail;
}

/** Best-effort CSI / OSC strip for overview preview; not a full terminal emulator. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[PX^_][^\u001b]*\u001b\\/g, '')
    .replace(/\u001b./g, '');
}
