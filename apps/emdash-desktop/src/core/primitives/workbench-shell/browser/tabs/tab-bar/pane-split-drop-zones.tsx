import { useDndContext, useDroppable } from '@dnd-kit/core';
import { cn } from '@core/primitives/styling/browser/cn';
import { paneDropTargetId, type SplitSide } from '../pane-drop-target';
import { usePaneLayoutContext } from '../pane-layout-context';

/**
 * Edge drop zones that create a new split pane on drop (VS Code style).
 * Mounted only while a drag is active, so the strips never intercept normal
 * pointer interaction with the pane content. Hit area is the outer 20% of the
 * content region; the hover highlight previews the half where the new pane
 * lands. PaneLayoutStore owns drop validity, so invalid zones are not mounted.
 */
export function PaneSplitDropZones({ paneId }: { paneId: string }) {
  const { active } = useDndContext();
  if (!active) return null;
  return (
    <>
      <SplitZone paneId={paneId} side="left" draggedId={String(active.id)} />
      <SplitZone paneId={paneId} side="right" draggedId={String(active.id)} />
    </>
  );
}

/**
 * Where a dragged tab will land: a quiet panel inset from the pane's edges, one faint step over
 * the content with a thin accent edge (the sidebar's drop target speaks the same way).
 */
export const DROP_PREVIEW_CLASS =
  'pointer-events-none absolute z-20 rounded-lg bg-foreground/5 ring-1 ring-ring/60 ring-inset motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150';

function SplitZone({
  paneId,
  side,
  draggedId,
}: {
  paneId: string;
  side: SplitSide;
  draggedId: string;
}) {
  const paneLayout = usePaneLayoutContext();
  const canSplit = paneLayout.canSplitAt(paneId, side, draggedId);
  const { setNodeRef, isOver } = useDroppable({
    id: paneDropTargetId({ kind: 'split', paneId, side }),
    disabled: !canSplit,
  });
  if (!canSplit) return null;
  return (
    <>
      <div
        ref={setNodeRef}
        className={cn('absolute inset-y-0 z-30 w-1/5', side === 'left' ? 'left-0' : 'right-0')}
      />
      {isOver && (
        <div
          className={cn(
            DROP_PREVIEW_CLASS,
            'inset-y-2 w-[calc(50%-0.75rem)]',
            side === 'left' ? 'left-2' : 'right-2'
          )}
        />
      )}
    </>
  );
}
