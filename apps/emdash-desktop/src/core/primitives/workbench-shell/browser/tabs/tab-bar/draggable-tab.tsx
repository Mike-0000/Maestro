import { useDraggable, useDroppable } from '@dnd-kit/core';
import { paneDropTargetId } from '../pane-drop-target';

export function DraggableTab({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={(el) => {
        setDragRef(el);
        setDropRef(el);
      }}
      // Tabs hang from the bottom of the strip so the active one meets the content below.
      style={{
        display: 'flex',
        height: '100%',
        alignItems: 'flex-end',
        position: 'relative',
      }}
      {...attributes}
      {...listeners}
    >
      {isOver && <DropIndicator />}
      {children}
    </div>
  );
}

function DropIndicator() {
  return (
    <div className="pointer-events-none absolute top-2.5 bottom-1.5 left-0 z-10 w-0.5 rounded-full bg-foreground" />
  );
}

export function PaneDropZone({ paneId }: { paneId: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: paneDropTargetId({ kind: 'tab-strip', paneId }),
  });
  return (
    <div ref={setNodeRef} className="relative h-full flex-1">
      {isOver && <DropIndicator />}
    </div>
  );
}
