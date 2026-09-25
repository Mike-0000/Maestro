import type { Terminal } from '@xterm/xterm';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import type { AgentTileEntry } from '../canvas-store';

const PREVIEW_REFRESH_MS = 250;
const PREVIEW_MAX_ROWS = 60;

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

function useTerminalTail(terminal: Terminal | undefined, rows: number): string[] {
  const [lines, setLines] = useState<string[]>(() => (terminal ? readTerminalTail(terminal, rows) : []));
  useEffect(() => {
    if (!terminal) {
      setLines([]);
      return;
    }
    setLines(readTerminalTail(terminal, rows));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscription = terminal.onWriteParsed(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setLines(readTerminalTail(terminal, rows));
      }, PREVIEW_REFRESH_MS);
    });
    return () => {
      subscription.dispose();
      if (timer) clearTimeout(timer);
    };
  }, [terminal, rows]);
  return lines;
}

/**
 * Read-only tail of an agent's terminal. Cheap enough to render for every tile at any zoom:
 * it reads the already-live xterm buffer rather than mounting a second terminal.
 */
export const AgentPreview = observer(function AgentPreview({
  entry,
  onActivate,
}: {
  entry: AgentTileEntry;
  onActivate: () => void;
}) {
  const session = entry.sessionActive
    ? conversationRegistry.get(entry.taskId)?.sessions.get(entry.conversationId)
    : undefined;
  // Observing `status` lazily connects the passive output subscription (it never starts the agent).
  const ready = session?.status === 'ready';
  const lines = useTerminalTail(ready ? session?.pty?.terminal : undefined, PREVIEW_MAX_ROWS);

  return (
    <button
      type="button"
      onClick={onActivate}
      className="group relative flex h-full w-full cursor-zoom-in flex-col justify-end overflow-hidden bg-(--xterm-bg) p-3 text-left"
    >
      {lines.length > 0 ? (
        <pre className="m-0 font-mono text-[12px] leading-[1.35] whitespace-pre text-(--xterm-fg) opacity-80">
          {lines.join('\n')}
        </pre>
      ) : (
        <span className="self-center pb-[40%] text-xs text-foreground-muted">
          {entry.sessionActive ? 'Waiting for output…' : 'Agent is not running'}
        </span>
      )}
    </button>
  );
});
