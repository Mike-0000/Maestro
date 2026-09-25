import { observer } from 'mobx-react-lite';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { useTuiOutputTail } from '../../api/browser/use-tui-output-tail';

/**
 * Read-only tail of an agent's TUI output. Does not observe PtySession.status, so it
 * never lazy-connects a FrontendPty / xterm. Working agents refresh at 4 Hz from the
 * retained live-log snapshot; idle agents keep the first snapshot.
 */
export const AgentPreview = observer(function AgentPreview({
  entry,
  onActivate,
}: {
  entry: AgentTileEntry;
  onActivate: () => void;
}) {
  const lines = useTuiOutputTail(
    entry.conversationId,
    entry.sessionActive,
    entry.status === 'working'
  );

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
