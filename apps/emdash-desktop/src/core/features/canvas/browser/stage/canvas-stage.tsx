import {
  ChevronLeft,
  ChevronRight,
  Expand,
  LayoutGrid,
  Maximize2,
  Minimize2,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceLayoutContext } from '@core/features/workbench/contributions/browser/layout-provider';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  EMPTY_STAGE,
  moveSplitter,
  pageKey,
  paneInDirection,
  stageView,
  swapInOrder,
  type Box,
  type StagePane,
  type StageSplitter,
  type StageView,
} from '../../api/stage-layout';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { isTypingTarget } from '../canvas-keys';
import { StagePaneContent } from './stage-pane';

const STAGE_PADDING = 8;
const PANE_DRAG_TYPE = 'application/x-chorus-stage-pane';

/**
 * The stage: a region (or a set of windows) tiled full screen at 100 %, every window live and
 * interactive. The board stays mounted underneath; closing the stage returns to it unchanged.
 */
export const CanvasStage = observer(function CanvasStage() {
  const store = getCanvasStore();
  const location = store.location;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [area, setArea] = useState<Box>({ x: 0, y: 0, w: 0, h: 0 });
  const [activePane, setActivePane] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!body) return;
    const measure = () => {
      const rect = body.getBoundingClientRect();
      setArea({
        x: STAGE_PADDING,
        y: STAGE_PADDING,
        w: Math.max(0, rect.width - STAGE_PADDING * 2),
        h: Math.max(0, rect.height - STAGE_PADDING * 2),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [body]);

  const natural = store.stageTileIds;
  const saved = store.stageSaved;
  const page = location.kind === 'stage' ? location.page : 0;
  const view = area.w > 0 ? stageView(natural, saved, area, page) : null;

  // Keep the stored page in range as windows come and go.
  useEffect(() => {
    if (view && view.page !== page) store.setStagePage(view.page);
  }, [view, page, store]);

  // Nothing left to show (the region emptied or was removed): back to the board.
  useEffect(() => {
    if (natural.length === 0) store.leaveStage();
  }, [natural.length, store]);

  useStageKeys(view, activePane, setActivePane);

  if (location.kind !== 'stage') return null;
  const paneIds = view ? view.panes.map((pane) => pane.tileId) : [];
  const key = pageKey(paneIds);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <StageHeader view={view} activePane={activePane} />
      <div ref={setBody} className="relative min-h-0 flex-1 bg-background-secondary/60">
        {view?.panes.map((pane) => (
          <StagePaneFrame
            key={pane.tileId}
            pane={pane}
            solo={view.soloTileId !== null}
            active={activePane === pane.tileId}
            onActivate={() => setActivePane(pane.tileId)}
          />
        ))}
        {view?.tree &&
          view.splitters.map((splitter) => (
            <Splitter
              key={`${splitter.path.join('.')}:${splitter.index}`}
              splitter={splitter}
              onDrag={(delta) =>
                store.updateStage('Resized panes', (current) => {
                  const tree = view.tree;
                  if (!tree) return current;
                  const base = current.trees[key] ?? tree;
                  return {
                    ...current,
                    trees: {
                      ...current.trees,
                      [key]: moveSplitter(base, splitter.path, splitter.index, delta),
                    },
                  };
                })
              }
            />
          ))}
      </div>
    </div>
  );
});

const StageHeader = observer(function StageHeader({
  view,
  activePane,
}: {
  view: StageView | null;
  activePane: string | null;
}) {
  const store = getCanvasStore();
  const location = store.location;
  const layout = useWorkspaceLayoutContext();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const immersive = location.kind === 'stage' && location.immersive;

  // Immersive stage hides the app chrome (zen mode) and restores it on the way out, unless the
  // user had zen on already or turned it off meanwhile.
  useEffect(() => {
    if (!immersive || layoutRef.current.isZenActive) return;
    layoutRef.current.toggleZenMode();
    return () => {
      if (layoutRef.current.isZenActive) layoutRef.current.toggleZenMode();
    };
  }, [immersive]);

  if (location.kind !== 'stage' || !view) return null;
  const solo = view.soloTileId;
  const adjusted = view.adjusted || store.stageSaved.order.length > 0;

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3 text-xs">
      <LayoutGrid className="size-4 shrink-0 text-foreground-muted" />
      <span className="shrink-0 text-sm font-semibold text-foreground">{store.stageTitle}</span>
      <span className="shrink-0 text-foreground-muted tabular-nums">
        {view.order.length} window{view.order.length === 1 ? '' : 's'}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2">
        {view.order.map((tileId, index) => {
          const onPage = view.panes.some((pane) => pane.tileId === tileId);
          return (
            <button
              key={tileId}
              type="button"
              title={
                solo === tileId
                  ? 'Back to all windows'
                  : onPage
                    ? 'Show only this window'
                    : 'Go to the page with this window'
              }
              onClick={() => {
                if (!onPage && view.pageSize > 0) {
                  store.setStagePage(Math.floor(index / view.pageSize));
                  return;
                }
                store.updateStage(solo === tileId ? 'Showed all windows' : 'Solo', (saved) => ({
                  ...saved,
                  soloTileId: saved.soloTileId === tileId ? null : tileId,
                }));
              }}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-0.5 font-medium',
                solo === tileId
                  ? 'border-blue-500 bg-blue-500/15 text-blue-700 dark:text-blue-300'
                  : onPage
                    ? 'border-border text-foreground hover:bg-background-secondary'
                    : 'border-transparent text-foreground-muted hover:bg-background-secondary',
                activePane === tileId && 'ring-1 ring-blue-500/60'
              )}
            >
              {store.windowName(tileId)}
            </button>
          );
        })}
      </div>
      {view.pageCount > 1 && !solo && (
        <span className="flex shrink-0 items-center gap-1">
          <StageButton
            label="Previous page"
            disabled={view.page === 0}
            onClick={() => store.setStagePage(view.page - 1)}
          >
            <ChevronLeft className="size-4" />
          </StageButton>
          <span className="text-foreground-muted tabular-nums">
            {view.page + 1} / {view.pageCount}
          </span>
          <StageButton
            label="Next page"
            disabled={view.page >= view.pageCount - 1}
            onClick={() => store.setStagePage(view.page + 1)}
          >
            <ChevronRight className="size-4" />
          </StageButton>
        </span>
      )}
      {adjusted && (
        <StageButton
          label="Reset the arrangement"
          onClick={() => store.updateStage('Reset the stage', () => EMPTY_STAGE)}
        >
          <RotateCcw className="size-3.5" />
        </StageButton>
      )}
      <StageButton
        label={store.undoLabel ? `Undo: ${store.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        disabled={!store.canUndo}
        onClick={() => store.undo()}
      >
        <Undo2 className="size-3.5" />
      </StageButton>
      <StageButton
        label={immersive ? 'Show the app chrome' : 'Immersive (hide the app chrome)'}
        onClick={() => store.setStageImmersive(!immersive)}
      >
        {immersive ? <Minimize2 className="size-3.5" /> : <Expand className="size-3.5" />}
      </StageButton>
      <button
        type="button"
        title="Back to the canvas (Esc)"
        onClick={() => store.leaveStage()}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 font-medium text-foreground hover:bg-background-secondary"
      >
        <X className="size-3.5" />
        Canvas
      </button>
    </div>
  );
});

const StagePaneFrame = observer(function StagePaneFrame({
  pane,
  solo,
  active,
  onActivate,
}: {
  pane: StagePane;
  solo: boolean;
  active: boolean;
  onActivate: () => void;
}) {
  const store = getCanvasStore();
  const [dropping, setDropping] = useState(false);
  const { rect, tileId } = pane;
  const badges = store.listening && store.layoutSettings.showNamesWhileListening;

  return (
    <div
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-lg border bg-background shadow-sm',
        active ? 'border-blue-500/70' : 'border-border',
        dropping && 'ring-2 ring-blue-500'
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => {
        onActivate();
        store.focusTile(tileId);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        const from = event.dataTransfer.getData(PANE_DRAG_TYPE);
        if (!from || from === tileId) return;
        event.preventDefault();
        store.updateStage('Swapped panes', (saved) => ({
          ...saved,
          order: swapInOrder(store.stageOrderNow(), from, tileId),
        }));
      }}
    >
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_DRAG_TYPE, tileId);
          event.dataTransfer.effectAllowed = 'move';
        }}
        className="flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border bg-background-secondary px-2 text-xs active:cursor-grabbing"
        title="Drag onto another pane to swap them"
      >
        <StagePaneTitle tileId={tileId} />
        <span className="flex-1" />
        <StageButton
          label={solo ? 'Back to all windows' : 'Show only this window'}
          onClick={() =>
            store.updateStage(solo ? 'Showed all windows' : 'Solo', (saved) => ({
              ...saved,
              soloTileId: saved.soloTileId === tileId ? null : tileId,
            }))
          }
        >
          {solo ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </StageButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <StagePaneContent
          tileId={tileId}
          active={active}
          placement={`${rect.x},${rect.y},${rect.w},${rect.h}`}
        />
        {badges && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <span className="rounded-2xl bg-background/90 px-6 py-2 text-5xl font-bold tracking-tight text-foreground shadow-lg">
              {store.windowName(tileId)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

const StagePaneTitle = observer(function StagePaneTitle({ tileId }: { tileId: string }) {
  const store = getCanvasStore();
  const entry = store.entryForTile(tileId);
  return (
    <>
      <span className="truncate font-semibold text-foreground">{store.windowName(tileId)}</span>
      {entry && (
        <span className="min-w-0 truncate text-foreground-muted">
          {entry.taskName} · {entry.projectName}
        </span>
      )}
    </>
  );
});

function Splitter({
  splitter,
  onDrag,
}: {
  splitter: StageSplitter;
  onDrag: (delta: number) => void;
}) {
  const horizontal = splitter.axis === 'row';
  const last = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      className={cn(
        'absolute z-10 rounded-full transition-colors hover:bg-blue-500/40 active:bg-blue-500/60',
        horizontal ? 'cursor-col-resize' : 'cursor-row-resize'
      )}
      style={{
        left: splitter.rect.x,
        top: splitter.rect.y,
        width: splitter.rect.w,
        height: splitter.rect.h,
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = horizontal ? event.clientX : event.clientY;
      }}
      onPointerMove={(event) => {
        if (last.current === null || splitter.span <= 0) return;
        const position = horizontal ? event.clientX : event.clientY;
        const delta = (position - last.current) / splitter.span;
        if (Math.abs(delta) < 0.002) return;
        last.current = position;
        onDrag(delta);
      }}
      onPointerUp={(event) => {
        last.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}

function StageButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-muted hover:bg-background-secondary hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * Stage keys (outside terminals and fields): Ctrl+Shift+Arrow moves between panes, Ctrl+Alt+Enter
 * solos the active pane, PageUp/PageDown flip pages.
 */
function useStageKeys(
  view: StageView | null,
  activePane: string | null,
  setActivePane: (tileId: string) => void
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!view || isTypingTarget(event.target)) return;
      const store = getCanvasStore();
      const mod = event.ctrlKey || event.metaKey;
      const current = activePane ?? view.panes[0]?.tileId ?? null;
      if (mod && event.altKey && event.key === 'Enter' && current) {
        store.updateStage('Solo', (saved) => ({
          ...saved,
          soloTileId: saved.soloTileId === current ? null : current,
        }));
        event.preventDefault();
        return;
      }
      if (event.key === 'PageDown' && view.page < view.pageCount - 1) {
        store.setStagePage(view.page + 1);
        event.preventDefault();
        return;
      }
      if (event.key === 'PageUp' && view.page > 0) {
        store.setStagePage(view.page - 1);
        event.preventDefault();
        return;
      }
      if (!mod || !event.shiftKey || !current) return;
      const direction =
        event.key === 'ArrowLeft'
          ? 'left'
          : event.key === 'ArrowRight'
            ? 'right'
            : event.key === 'ArrowUp'
              ? 'up'
              : event.key === 'ArrowDown'
                ? 'down'
                : null;
      if (!direction) return;
      const next = paneInDirection(view.panes, current, direction);
      if (!next) return;
      setActivePane(next);
      store.focusTile(next);
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, activePane, setActivePane]);
}
