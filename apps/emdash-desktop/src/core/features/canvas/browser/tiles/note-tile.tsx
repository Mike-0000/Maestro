import { NodeResizer, type NodeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { NoteTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { MIN_TILE_SIZE } from '../../api/canvas-model';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { useIsLivePane } from '../canvas-pane-context';
import { NOTE_SURFACE, NOTE_SWATCH, RESIZE_HANDLE_CLASS } from '../canvas-styles';
import { TileIconButton } from './tile-icon-button';

export type NoteTileData = { tileId: string; noteId: string };

const COLOR_ORDER: NoteTileEntry['color'][] = ['yellow', 'blue', 'green', 'pink', 'gray'];

/**
 * A sticky note: a card tinted with the colour the user gave it, its text, and quiet controls
 * (colour swatches and delete) that show while the note is hovered or holds focus.
 */
export const NoteTileNode = observer(function NoteTileNode({ data, selected }: NodeProps) {
  const { tileId, noteId } = data as NoteTileData;
  const store = getCanvasStore();
  const note = store.noteEntries.find((entry) => entry.noteId === noteId);
  // Multi-canvas: a note showing in several views is edited in one; the others follow its text.
  const live = useIsLivePane(tileId);
  if (!note) return null;

  return (
    <div
      className={cn(
        'group/window flex h-full w-full flex-col overflow-hidden rounded-lg border border-border-subtle',
        NOTE_SURFACE[note.color]
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_TILE_SIZE.w / 2}
        minHeight={MIN_TILE_SIZE.h / 2}
        handleClassName={RESIZE_HANDLE_CLASS}
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <div className="flex h-8 shrink-0 items-center gap-1.5 pr-1 pl-3 opacity-0 transition-opacity group-focus-within/window:opacity-100 group-hover/window:opacity-100">
        {COLOR_ORDER.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Color ${color}`}
            aria-pressed={note.color === color}
            onClick={() => store.updateNote(noteId, { color })}
            className={cn(
              'nodrag size-3 rounded-full ring-offset-1 ring-offset-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              NOTE_SWATCH[color],
              note.color === color && 'ring-2 ring-foreground-muted'
            )}
          />
        ))}
        <span className="flex-1" />
        <TileIconButton label="Delete note" onClick={() => store.removeNote(noteId)}>
          <Trash2 className="size-3.5" />
        </TileIconButton>
      </div>
      <textarea
        key={live ? 'live' : note.text}
        readOnly={!live}
        className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-3 pb-3 text-sm text-foreground outline-none placeholder:text-foreground-passive"
        placeholder="Write a goal, a plan, or a prompt…"
        defaultValue={note.text}
        onBlur={(event) => {
          if (live) store.updateNote(noteId, { text: event.currentTarget.value });
        }}
      />
    </div>
  );
});
