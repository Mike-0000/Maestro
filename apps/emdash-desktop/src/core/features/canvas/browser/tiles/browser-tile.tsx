import { StateGlyph } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { Bot, Globe, Hand, Maximize2, X } from 'lucide-react';
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
import {
  FLOATING_LAYER,
  RESIZE_HANDLE_CLASS,
  WINDOW_ACTIONS,
  WINDOW_FRAME,
  WINDOW_HEADER,
} from '../canvas-styles';
import { TileIconButton } from './tile-icon-button';

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
  // Canvas Pro: windows visiting this desk float above its own, and a live page would cover them.
  const eclipsed = store.visitorsFloating && !store.visitorRects.has(tileId);
  useLayoutEffect(() => {
    if (!browserId || !owner) return;
    // The stage owns a staged browser's surface; other board browsers hide behind the stage.
    if (stageActive) {
      if (!staged) host.placeSurface(browserId, null);
      return;
    }
    if (eclipsed) {
      host.placeSurface(browserId, null);
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
      className={cn(WINDOW_FRAME, focused && 'border-ring')}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && !glyph}
        minWidth={MIN_TILE_SIZE.w}
        minHeight={MIN_TILE_SIZE.h}
        handleClassName={RESIZE_HANDLE_CLASS}
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <BrowserTileHeader entry={entry} glyph={glyph} leased={leased} onActivate={activate} />
      <div ref={pageRef} data-browser-page={browserId} className="relative min-h-0 flex-1">
        {!live &&
          (glyph ? (
            <div className="flex h-full items-center justify-center gap-4 px-6 text-3xl text-foreground-muted">
              <Globe className="size-10 shrink-0" />
              <span className="truncate">{entry.title ?? hostLabel(entry.url)}</span>
            </div>
          ) : (
            <button
              type="button"
              className="nodrag group/page flex h-full w-full items-center justify-center overflow-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
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
                <span className="flex flex-col items-center gap-1 text-center">
                  <span className="text-sm font-medium text-foreground">
                    {alive ? 'Loading…' : 'Paused'}
                  </span>
                  {!alive && (
                    <span className="text-xs text-foreground-muted">Click to resume.</span>
                  )}
                </span>
              )}
              {preview && (
                <span
                  className={cn(
                    FLOATING_LAYER,
                    'pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs opacity-0 transition-opacity group-hover/page:opacity-100 group-focus-visible/page:opacity-100'
                  )}
                >
                  {alive ? 'Click to interact' : 'Click to resume'}
                </span>
              )}
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
      className={cn(WINDOW_HEADER, glyph ? 'h-16 gap-3 px-4' : 'pr-1.5 pl-3')}
      style={glyph ? undefined : { height: BROWSER_TILE_HEADER }}
    >
      <Globe className={cn('shrink-0 text-foreground-passive', glyph ? 'size-7' : 'size-3.5')} />
      <span
        className={cn(
          'min-w-0 truncate text-foreground',
          glyph ? 'text-2xl font-medium' : 'text-xs'
        )}
        title={entry.url}
      >
        {entry.title || hostLabel(entry.url)}
      </span>
      {!glyph && (
        <span className="min-w-0 truncate text-tiny text-foreground-passive">{entry.taskName}</span>
      )}
      <span className="flex-1" />
      {leased && <LeaseLine browserId={entry.browserId} label={activity ?? 'Driving the app'} />}
      {!glyph && (
        <span className="flex shrink-0 items-center gap-0.5">
          {/* Who may use the app: a fact worth seeing at rest, so it never hides with the rest. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={agents}
            onClick={() => void host.setControl(entry, agents ? 'user' : 'agents')}
            title={
              agents
                ? 'Agents and the conductor may use this app. Click to take it back.'
                : 'Only you use this app. Click to let agents and the conductor use it.'
            }
            className="nodrag gap-1 px-1.5 text-tiny"
          >
            {agents ? <Bot className="size-3.5" /> : <Hand className="size-3.5" />}
            {agents ? 'Agents' : 'You'}
          </Button>
          <span className={WINDOW_ACTIONS}>
            <TileIconButton label="Focus (100 %)" onClick={onActivate}>
              <Maximize2 className="size-3.5" />
            </TileIconButton>
            <TileIconButton label="Close app browser" onClick={() => void host.close(entry)}>
              <X className="size-3.5" />
            </TileIconButton>
          </span>
        </span>
      )}
    </div>
  );
});

/** An agent is driving the app: the working mark, what it is doing, and the way to stop it. */
const LeaseLine = observer(function LeaseLine({
  browserId,
  label,
}: {
  browserId: string;
  label: string;
}) {
  const host = getCanvasBrowserHost();
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-foreground">
      <StateGlyph state="working" size="sm" />
      <span className="max-w-64 truncate">{label}</span>
      <Button
        type="button"
        variant="text"
        size="xs"
        className="nodrag ml-1"
        onClick={() => void host.stopLease(browserId)}
      >
        Stop
      </Button>
    </span>
  );
});

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
