import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef } from 'react';
import { BrowserSurface } from '@core/features/browser/contributions/browser/browser-surface';
import { BROWSER_TILE_HEADER, BROWSER_TILE_SIZE, type TileRect } from '../api/canvas-model';
import { getCanvasBrowserHost, getCanvasStore } from '../contributions/browser/app-stores';

/** Size a hidden page keeps, so captures and model screenshots match the tile at 100 %. */
const HIDDEN_PAGE_SIZE = {
  width: BROWSER_TILE_SIZE.w,
  height: BROWSER_TILE_SIZE.h - BROWSER_TILE_HEADER,
};

/**
 * Renders every alive canvas app browser at the workspace shell, outside React Flow and the view
 * slot. Pages survive panning, node virtualization, and leaving the canvas. A page is positioned
 * over its tile while that tile is live; otherwise it is transparent and ignores the pointer. Hidden pages stay
 * rendered (opacity, not `visibility`): a guest the compositor stops painting cannot be captured.
 * Children are keyed and only ever appended or removed, so React never moves a webview node
 * (Electron reloads a guest whose element moves).
 */
export const BrowserSurfaceHost = observer(function BrowserSurfaceHost() {
  const host = getCanvasBrowserHost();
  if (host.alive.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[5] overflow-hidden" aria-live="off">
      {host.alive.map((browserId) => (
        <HostedBrowser key={browserId} browserId={browserId} />
      ))}
    </div>
  );
});

const HostedBrowser = observer(function HostedBrowser({ browserId }: { browserId: string }) {
  const host = getCanvasBrowserHost();
  const canvas = getCanvasStore();
  const ref = useRef<HTMLDivElement | null>(null);
  const layout = host.layouts.get(browserId);
  const live = layout?.live ?? false;
  const entry = canvas.browserEntries.find((candidate) => candidate.browserId === browserId);

  // Hidden pages are out of the accessibility tree and take no pointer input. They are not
  // `inert`: that blocks focus inside the guest, so a model could not type into a hidden page.
  useLayoutEffect(() => {
    ref.current?.setAttribute('aria-hidden', live ? 'false' : 'true');
  }, [live]);

  const style: React.CSSProperties =
    live && layout
      ? {
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
          opacity: 1,
          pointerEvents: 'auto',
          ...(layout.holes.length > 0
            ? { clipPath: clipOut(layout.width, layout.height, layout.holes) }
            : {}),
        }
      : {
          left: 0,
          top: 0,
          ...HIDDEN_PAGE_SIZE,
          opacity: 0,
          pointerEvents: 'none',
        };

  return (
    <div
      ref={ref}
      data-browser-surface={browserId}
      className="absolute overflow-hidden rounded-b-xl bg-background"
      style={style}
      onPointerDownCapture={() => {
        host.touch(browserId);
        if (entry) canvas.focusTile(entry.tileId);
      }}
    >
      <BrowserSurface
        browserId={browserId}
        visible={live}
        devServerUrls={
          entry
            ? host.devServerUrls({ projectId: entry.projectId, workspaceId: entry.workspaceId })
            : []
        }
        profileLocked
      />
    </div>
  );
});

/** A clip path showing the page minus `holes` (even-odd: each hole cuts the full rectangle). */
function clipOut(width: number, height: number, holes: readonly TileRect[]): string {
  const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  const path = [rect(0, 0, width, height), ...holes.map((h) => rect(h.x, h.y, h.w, h.h))];
  return `path(evenodd, '${path.join('')}')`;
}
