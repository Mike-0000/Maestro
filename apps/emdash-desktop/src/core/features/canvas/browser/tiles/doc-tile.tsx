import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { BookOpenText, Maximize2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { DocTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { MarkdownDocView } from '@core/features/markdown-viewer/contributions/browser/markdown-doc-view';
import { cn } from '@core/primitives/styling/browser/cn';
import { BROWSER_TILE_HEADER, GLYPH_ZOOM_THRESHOLD } from '../../api/canvas-model';
import { minSizeOf } from '../../api/canvas-regions';
import { getCanvasStore } from '../../contributions/browser/app-stores';

export type DocTileData = { tileId: string };

/**
 * A Markdown file as a window on the canvas: the read-only viewer under a header that names the
 * file and the task it came from. It moves, resizes, joins regions and goes on the stage like any
 * other window.
 */
export const DocTileNode = observer(function DocTileNode({ data, selected }: NodeProps) {
  const { tileId } = data as DocTileData;
  const store = getCanvasStore();
  const entry = store.docEntries.find((candidate) => candidate.tileId === tileId);
  // Far out, the rendered text is unreadable: the window shows its title instead.
  const glyph = useStore((state) => state.transform[2] < GLYPH_ZOOM_THRESHOLD);
  if (!entry) return null;
  const focused = store.focusedTileId === tileId;
  const min = minSizeOf(tileId);

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-xl border bg-background shadow-lg',
        focused ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-border'
      )}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && !glyph}
        minWidth={min.w}
        minHeight={min.h}
        lineClassName="!border-blue-500/60"
        handleClassName="!size-2.5 !rounded-sm !border-blue-500 !bg-background"
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <DocTileHeader entry={entry} glyph={glyph} />
      {glyph ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-3 px-6 text-3xl text-foreground-muted">
          <BookOpenText className="size-10 shrink-0" />
          <span className="truncate">{entry.title}</span>
        </div>
      ) : (
        // The document scrolls and its text selects: neither pans the board nor drags the window.
        <div className="nodrag nowheel min-h-0 flex-1 cursor-auto select-text">
          <MarkdownDocView key={`${entry.workspaceId}:${entry.path}`} doc={entry} />
        </div>
      )}
    </div>
  );
});

function DocTileHeader({ entry, glyph }: { entry: DocTileEntry; glyph: boolean }) {
  const store = getCanvasStore();
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border bg-background-secondary px-3',
        glyph && 'h-16'
      )}
      style={glyph ? undefined : { height: BROWSER_TILE_HEADER }}
    >
      <BookOpenText
        className={cn('shrink-0 text-foreground-muted', glyph ? 'size-7' : 'size-3.5')}
      />
      <span
        className={cn(
          'min-w-0 truncate font-medium text-foreground',
          glyph ? 'text-2xl' : 'text-xs'
        )}
        title={entry.path}
      >
        {entry.title}
      </span>
      {!glyph && (
        <span className="min-w-0 truncate text-[11px] text-foreground-muted">{entry.taskName}</span>
      )}
      <span className="flex-1" />
      {!glyph && (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => store.enterStage({ kind: 'solo', tileId: entry.tileId })}
            title="Read at full size"
            aria-label="Read at full size"
            className="nodrag flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background hover:text-foreground"
          >
            <Maximize2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => store.closeDoc(entry.docId)}
            title="Close"
            aria-label="Close this document"
            className="nodrag flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}
