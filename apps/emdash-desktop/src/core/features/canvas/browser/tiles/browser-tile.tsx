import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { Bot, Globe, Hand, Maximize2, Play, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef } from 'react';
import type { BrowserTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  BROWSER_TILE_HEADER,
  GLYPH_ZOOM_THRESHOLD,
  MIN_TILE_SIZE,
  rectContains,
  resolveBrowserTileMode,
  type TileRect,
} from '../../api/canvas-model';
import { getCanvasBrowserHost, getCanvasStore } from '../../contributions/browser/app-stores';
import { useIsLivePane } from '../canvas-pane-context';

export type BrowserTileData = { tileId: string };

/** Canvas chrome drawn over the board (toolbar, minimap); a live page must not cover it. */
export const CANVAS_OVERLAY_ATTRIBUTE = 'data-canvas-overlay';

/**
 * A task's app browser on the canvas. The tile only reserves space: the real webview lives in
 * `BrowserSurfaceHost` and is placed over the tile while it can be shown live (interactive zoom,
 * fully in view). Otherwise the tile shows the last capture.
 */
export const BrowserTileNode = observer(function BrowserTileNode({ data, selected }: NodeProps) {
  const { tileId } = data as BrowserTileData;
  const store = getCanvasStore();
  const host = getCanvasBrowserHost();
  const entry = store.browserEntries.find((candidate) => candidate.tileId === tileId);
  // Re-render on every pan/zoom frame: the webview follows the tile while it is live.
  const transform = useStore((state) => state.transform);
  const zoom = transform[2];
  const domNode = useStore((state) => state.domNode);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const browserId = entry?.browserId;
  const alive = browserId ? host.isAlive(browserId) : false;
  const leased = browserId ? host.isLeased(browserId) : false;
  // Multi-canvas: one webview per browser, so only the view the tile is live in places it. The
  // other views show the last capture.
  const owner = useIsLivePane(tileId);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  // Report where the page area is on screen so the host can place (or hide) the webview. Runs
  // after every render: drags, resizes, and viewport moves all re-render this node.
  const stageActive = store.stageActive;
  const staged = browserId ? store.isStaged(tileId) : false;
  useLayoutEffect(() => {
    if (!browserId || !owner) return;
    // The stage owns a staged browser's surface; other board browsers hide behind the stage.
    if (stageActive) {
      if (!staged) host.placeSurface(browserId, null);
      return;
    }
    const page = pageRef.current;
    if (!page || !domNode) {
      host.placeSurface(browserId, null);
      return;
    }
    const rect = page.getBoundingClientRect();
    const screen: TileRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    const bounds = domNode.getBoundingClientRect();
    const inView = rectContains(
      { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height },
      screen
    );
    const left = Math.round(rect.left);
    const top = Math.round(rect.top);
    // Canvas chrome drawn over the page is cut out of the live webview, which sits above it.
    const holes = [...document.querySelectorAll(`[${CANVAS_OVERLAY_ATTRIBUTE}]`)].flatMap(
      (element) => {
        const hole = intersection(element.getBoundingClientRect(), rect);
        return hole ? [{ ...hole, x: hole.x - left, y: hole.y - top }] : [];
      }
    );
    const mode = resolveBrowserTileMode({ zoom, fullyVisible: inView, alive });
    host.placeSurface(browserId, {
      left,
      top,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      live: mode === 'live',
      holes,
    });
  });

  // A layout effect, so a tile leaving one view hides the page before another view places it.
  useLayoutEffect(() => {
    if (!browserId) return;
    return () => {
      if (ownerRef.current && !getCanvasStore().isStaged(tileId)) {
        host.placeSurface(browserId, null);
      }
    };
  }, [browserId, host, tileId]);

  if (!entry || !browserId) return null;
  const layout = host.layouts.get(browserId);
  const live = owner && (layout?.live ?? false);
  const glyph = zoom < GLYPH_ZOOM_THRESHOLD;
  const focused = store.focusedTileId === tileId;
  const preview = host.previews.get(browserId);
  const activate = () => {
    host.ensureAlive(browserId);
    store.requestFocus(tileId);
  };

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-xl border bg-background shadow-lg',
        focused ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-border',
        leased && 'border-violet-500 ring-2 ring-violet-500/40'
      )}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && !glyph}
        minWidth={MIN_TILE_SIZE.w}
        minHeight={MIN_TILE_SIZE.h}
        lineClassName="!border-blue-500/60"
        handleClassName="!size-2.5 !rounded-sm !border-blue-500 !bg-background"
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <BrowserTileHeader entry={entry} glyph={glyph} leased={leased} onActivate={activate} />
      <div
        ref={pageRef}
        data-browser-page={browserId}
        className="relative min-h-0 flex-1 bg-background-secondary"
      >
        {!live &&
          (glyph ? (
            <div className="flex h-full items-center justify-center text-3xl text-foreground-muted">
              <Globe className="mr-3 size-10" />
              {entry.title ?? hostLabel(entry.url)}
            </div>
          ) : (
            <button
              type="button"
              className="nodrag group flex h-full w-full items-center justify-center overflow-hidden"
              onClick={activate}
              title="Click to use this app at 100 %"
            >
              {preview ? (
                <img
                  src={preview}
                  alt={`Last view of ${entry.title ?? entry.url}`}
                  className="h-full w-full object-cover object-top"
                  draggable={false}
                />
              ) : (
                <span className="flex flex-col items-center gap-2 text-sm text-foreground-muted">
                  <Play className="size-6" />
                  {alive ? 'Loading…' : 'Paused. Click to resume.'}
                </span>
              )}
              <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-3 py-1 text-xs text-foreground-muted opacity-0 shadow group-hover:opacity-100">
                {alive ? 'Click to interact' : 'Click to resume'}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
});

const BrowserTileHeader = observer(function BrowserTileHeader({
  entry,
  glyph,
  leased,
  onActivate,
}: {
  entry: BrowserTileEntry;
  glyph: boolean;
  leased: boolean;
  onActivate: () => void;
}) {
  const host = getCanvasBrowserHost();
  const activity = host.activity.get(entry.browserId);
  const agents = entry.control === 'agents';
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border bg-background-secondary px-3',
        glyph && 'h-16'
      )}
      style={glyph ? undefined : { height: BROWSER_TILE_HEADER }}
    >
      <Globe className={cn('shrink-0 text-foreground-muted', glyph ? 'size-7' : 'size-3.5')} />
      <span
        className={cn(
          'min-w-0 truncate font-medium text-foreground',
          glyph ? 'text-2xl' : 'text-xs'
        )}
        title={entry.url}
      >
        {entry.title || hostLabel(entry.url)}
      </span>
      {!glyph && (
        <span className="min-w-0 truncate text-[11px] text-foreground-muted">{entry.taskName}</span>
      )}
      <span className="flex-1" />
      {leased && <LeaseBanner browserId={entry.browserId} label={activity ?? 'Driving the app'} />}
      {!glyph && (
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void host.setControl(entry, agents ? 'user' : 'agents')}
            title={
              agents
                ? 'Agents and the conductor may use this app. Click to take it back.'
                : 'Only you use this app. Click to let agents and the conductor use it.'
            }
            className={cn(
              'nodrag flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium',
              agents
                ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                : 'text-foreground-muted hover:bg-background-tertiary hover:text-foreground'
            )}
          >
            {agents ? <Bot className="size-3.5" /> : <Hand className="size-3.5" />}
            {agents ? 'Agents' : 'You'}
          </button>
          <TileButton label="Focus (100 %)" onClick={onActivate}>
            <Maximize2 className="size-3.5" />
          </TileButton>
          <TileButton label="Close app browser" onClick={() => void host.close(entry)}>
            <X className="size-3.5" />
          </TileButton>
        </span>
      )}
    </div>
  );
});

const LeaseBanner = observer(function LeaseBanner({
  browserId,
  label,
}: {
  browserId: string;
  label: string;
}) {
  const host = getCanvasBrowserHost();
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-violet-600 py-0.5 pr-0.5 pl-2 text-[11px] text-white">
      <Bot className="size-3.5" />
      <span className="max-w-64 truncate">{label}</span>
      <button
        type="button"
        className="nodrag rounded-full bg-white/20 px-2 font-medium hover:bg-white/30"
        onClick={() => void host.stopLease(browserId)}
      >
        Stop
      </button>
    </div>
  );
});

function TileButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="nodrag flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
    >
      {children}
    </button>
  );
}

function intersection(a: DOMRect, b: DOMRect): TileRect | null {
  const x = Math.max(a.left, b.left);
  const y = Math.max(a.top, b.top);
  const w = Math.min(a.right, b.right) - x;
  const h = Math.min(a.bottom, b.bottom) - y;
  return w > 0 && h > 0
    ? { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
    : null;
}

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' ? 'New app browser' : parsed.host;
  } catch {
    return url;
  }
}
