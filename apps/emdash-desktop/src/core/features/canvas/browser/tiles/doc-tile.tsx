import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { BookOpenText, Maximize2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { DocTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { MarkdownDocView } from '@core/features/markdown-viewer/contributions/browser/markdown-doc-view';
import { cn } from '@core/primitives/styling/browser/cn';
import { BROWSER_TILE_HEADER, GLYPH_ZOOM_THRESHOLD } from '../../api/canvas-model';
import { minSizeOf } from '../../api/canvas-regions';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { RESIZE_HANDLE_CLASS, WINDOW_ACTIONS, WINDOW_FRAME, WINDOW_HEADER } from '../canvas-styles';
import { TileIconButton } from './tile-icon-button';

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
      className={cn(WINDOW_FRAME, focused && 'border-ring')}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && !glyph}
        minWidth={min.w}
        minHeight={min.h}
        handleClassName={RESIZE_HANDLE_CLASS}
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <DocTileHeader entry={entry} glyph={glyph} />
      {glyph ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-4 px-6 text-3xl text-foreground-muted">
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
      className={cn(WINDOW_HEADER, glyph ? 'h-16 gap-3 px-4' : 'pr-1.5 pl-3')}
      style={glyph ? undefined : { height: BROWSER_TILE_HEADER }}
    >
      <BookOpenText
        className={cn('shrink-0 text-foreground-passive', glyph ? 'size-7' : 'size-3.5')}
      />
      <span
        className={cn(
          'min-w-0 truncate text-foreground',
          glyph ? 'text-2xl font-medium' : 'text-xs'
        )}
        title={entry.path}
      >
        {entry.title}
      </span>
      {!glyph && (
        <span className="min-w-0 truncate text-tiny text-foreground-passive">{entry.taskName}</span>
      )}
      <span className="flex-1" />
      {!glyph && (
        <span className={WINDOW_ACTIONS}>
          <TileIconButton
            label="Read at full size"
            onClick={() => store.enterStage({ kind: 'solo', tileId: entry.tileId })}
          >
            <Maximize2 className="size-3.5" />
          </TileIconButton>
          <TileIconButton label="Close this document" onClick={() => store.closeDoc(entry.docId)}>
            <X className="size-3.5" />
          </TileIconButton>
        </span>
      )}
    </div>
  );
}
