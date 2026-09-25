import { NodeResizer, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { NoteTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { MIN_TILE_SIZE } from '../../api/canvas-model';
import { getCanvasStore } from '../../contributions/browser/app-stores';

export type NoteTileData = { tileId: string; noteId: string };

const NOTE_COLORS: Record<NoteTileEntry['color'], string> = {
  yellow: 'bg-amber-100 dark:bg-amber-950/70',
  blue: 'bg-sky-100 dark:bg-sky-950/70',
  green: 'bg-emerald-100 dark:bg-emerald-950/70',
  pink: 'bg-pink-100 dark:bg-pink-950/70',
  gray: 'bg-background-secondary',
};

const COLOR_ORDER: NoteTileEntry['color'][] = ['yellow', 'blue', 'green', 'pink', 'gray'];

export const NoteTileNode = observer(function NoteTileNode({ data, selected }: NodeProps) {
  const { tileId, noteId } = data as NoteTileData;
  const store = getCanvasStore();
  const note = store.noteEntries.find((entry) => entry.noteId === noteId);
  if (!note) return null;

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg border border-border shadow-md',
        NOTE_COLORS[note.color]
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_TILE_SIZE.w / 2}
        minHeight={MIN_TILE_SIZE.h / 2}
        lineClassName="!border-blue-500/60"
        handleClassName="!size-2.5 !rounded-sm !border-blue-500 !bg-background"
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <div className="flex h-7 shrink-0 items-center gap-1 px-2">
        {COLOR_ORDER.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Color ${color}`}
            onClick={() => store.updateNote(noteId, { color })}
            className={cn(
              'nodrag size-3 rounded-full border border-foreground/20',
              NOTE_COLORS[color],
              note.color === color && 'ring-2 ring-blue-500'
            )}
          />
        ))}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Delete note"
          onClick={() => store.removeNote(noteId)}
          className="nodrag flex size-5 items-center justify-center rounded text-foreground-muted hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <textarea
        className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-3 pb-3 text-sm text-foreground outline-none placeholder:text-foreground-muted"
        placeholder="Write a goal, a plan, or a prompt…"
        defaultValue={note.text}
        onBlur={(event) => store.updateNote(noteId, { text: event.currentTarget.value })}
      />
    </div>
  );
});
