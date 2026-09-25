import type { Terminal } from '@xterm/xterm';

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
