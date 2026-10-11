import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { comparer, reaction, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { MAX_ZOOM, MIN_ZOOM, viewportRect, type TileRect } from '../api/canvas-model';
import { PANE_DIVIDER, paneGrid } from '../api/canvas-panes';
import {
  descendantRegions,
  descendantTiles,
  isRegionId,
  isWithin,
  regionFootprint,
  type LayoutState,
} from '../api/canvas-regions';
import { frameViewport } from '../api/region-tiling';
import { getCanvasStore } from '../contributions/browser/app-stores';
import { handleCanvasKey } from './canvas-keys';
import { CanvasPaneContext } from './canvas-pane-context';
import { CanvasToolbar } from './canvas-toolbar';
import { CanvasStage } from './stage/canvas-stage';
import { AgentTileNode } from './tiles/agent-tile';
import { BrowserTileNode, CANVAS_OVERLAY_ATTRIBUTE } from './tiles/browser-tile';
import { DocTileNode } from './tiles/doc-tile';
import { NoteTileNode } from './tiles/note-tile';
import { GhostNode, RegionNode, regionStyle } from './tiles/region-node';
import { TaskFrameNode } from './tiles/task-frame';

const SCRIM_NODE_ID = 'desk:scrim';
/** Visitors sit above the desk's own windows (0) and below layout previews (2000). */
const VISITOR_Z = 50;
/** A desk swap fades in this fast: a cut, softened. */
const DESK_SWAP_MS = 160;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Behind visiting windows: the desk recedes, and a click on it sends the visitors home. */
function ScrimNode() {
  return (
    <button
      type="button"
      aria-label="Send the visiting windows back to their desks"
      title="Send the visiting windows back to their desks"
      onClick={() => getCanvasStore().sendBack()}
      className="h-full w-full cursor-default rounded-3xl bg-background/70"
    />
  );
}

const nodeTypes: NodeTypes = {
  agent: AgentTileNode,
  browser: BrowserTileNode,
  doc: DocTileNode,
  note: NoteTileNode,
  frame: TaskFrameNode,
  region: RegionNode,
  ghost: GhostNode,
  scrim: ScrimNode,
};

const overlayProps = { [CANVAS_OVERLAY_ATTRIBUTE]: '' };

const FOCUS_ANIMATION_MS = 350;
/** Entering, leaving, and switching sub-canvases: a little slower, so the move reads. */
const SCOPE_ANIMATION_MS = 420;
/** Windows and regions outside the sub-canvas the user is in recede. */
const OUTSIDE_SCOPE_OPACITY = 0.3;
/** How long layout changes animate and their targets glow. */
const LAYOUT_ANIMATION_MS = 450;
const FLASH_MS = 1600;
const FLASH_CLASS = 'chorus-flash';

function tileNode(type: string, rect: TileRect, id: string, data: Record<string, unknown>): Node {
  return {
    id,
    type,
    position: { x: rect.x, y: rect.y },
    width: rect.w,
    height: rect.h,
    data,
  };
}

/** Whether a node is outside the focused sub-canvas (it recedes while the user is in one). */
function outsideScope(layout: LayoutState, scope: string | null, id: string): boolean {
  return scope !== null && !isWithin(layout, id, scope);
}

const recede = (outside: boolean) => (outside ? { opacity: OUTSIDE_SCOPE_OPACITY } : undefined);

/** A visiting window floats above the desk it visits; it has no place there to drag it from. */
function visitorNode(node: Node): Node {
  return {
    ...node,
    zIndex: VISITOR_Z,
    draggable: false,
    // Selection commands (group, nudge, resize) would edit its own desk, out of sight.
    selectable: false,
    style: {
      borderRadius: 12,
      boxShadow: '0 0 0 2px rgb(139 92 246 / 0.75), 0 24px 60px rgb(0 0 0 / 0.35)',
    },
  };
}

/** Desired node geometry from the store; React Flow keeps selection and drag state. */
function buildNodes(store: CanvasStore, pane: number): Node[] {
  const nodes: Node[] = [];
  const layout = store.layoutState;
  // Each multi-canvas view recedes what is outside the sub-canvas that view is in.
  const scope = store.paneScope(pane);
  // Canvas Pro: only the desk in view is drawn, with the windows visiting it.
  const pro = store.proMode;
  const desk = store.activeDeskId;
  const visitors = store.visitorRects;
  const offDesk = (id: string) =>
    pro && !visitors.has(id) && !(desk !== null && isWithin(layout, id, desk));
  const outside = (id: string) => !visitors.has(id) && outsideScope(layout, scope, id);
  const placed = (node: Node) => (visitors.has(node.id) ? visitorNode(node) : node);
  // Regions first and lowest (nested ones above their parents), then task frames, then windows.
  // Only their header strips take pointer input.
  for (const region of store.regionEntries) {
    if (offDesk(region.regionId)) continue;
    nodes.push({
      id: region.regionId,
      type: 'region',
      position: { x: region.rect.x, y: region.rect.y },
      width: region.rect.w,
      height: region.rect.h,
      zIndex: -20 + region.depth,
      dragHandle: '.chorus-region-handle',
      style: { pointerEvents: 'none', ...recede(outside(region.regionId)) },
      data: { regionId: region.regionId },
    });
  }
  for (const frame of store.taskFrames) {
    if (pro && frame.tileIds.some((id) => offDesk(id) || visitors.has(id))) continue;
    nodes.push({
      id: frame.frameId,
      type: 'frame',
      position: { x: frame.rect.x, y: frame.rect.y },
      width: frame.rect.w,
      height: frame.rect.h,
      zIndex: -1,
      selectable: false,
      dragHandle: '.chorus-frame-handle',
      style: { pointerEvents: 'none', ...recede(frame.tileIds.some(outside)) },
      data: { frameId: frame.frameId },
    });
  }
  // A visitor shows wherever it lives, folded away or not: it was asked for.
  const skipped = (id: string) => offDesk(id) || (!visitors.has(id) && store.isFolded(id));
  for (const entry of store.visibleAgentEntries) {
    if (skipped(entry.tileId)) continue;
    nodes.push(
      placed({
        ...tileNode('agent', store.tileRect(entry.tileId), entry.tileId, {
          tileId: entry.tileId,
          projectId: entry.projectId,
          taskId: entry.taskId,
          conversationId: entry.conversationId,
        }),
        style: recede(outside(entry.tileId)),
      })
    );
  }
  for (const browser of store.visibleBrowserEntries) {
    if (skipped(browser.tileId)) continue;
    nodes.push(
      placed({
        ...tileNode('browser', store.tileRect(browser.tileId), browser.tileId, {
          tileId: browser.tileId,
        }),
        style: recede(outside(browser.tileId)),
      })
    );
  }
  for (const doc of store.visibleDocEntries) {
    if (skipped(doc.tileId)) continue;
    nodes.push(
      placed({
        ...tileNode('doc', store.tileRect(doc.tileId), doc.tileId, { tileId: doc.tileId }),
        style: recede(outside(doc.tileId)),
      })
    );
  }
  for (const note of store.noteEntries) {
    if (skipped(note.tileId)) continue;
    nodes.push(
      placed({
        ...tileNode('note', store.tileRect(note.tileId), note.tileId, {
          tileId: note.tileId,
          noteId: note.noteId,
        }),
        style: recede(outside(note.tileId)),
      })
    );
  }
  // Visitors floating above a desk's own windows: the desk recedes behind a scrim.
  const deskRect = desk && store.visitorsFloating ? store.regionEntry(desk)?.rect : undefined;
  if (deskRect) {
    nodes.push({
      ...tileNode('scrim', deskRect, SCRIM_NODE_ID, {}),
      zIndex: VISITOR_Z - 1,
      selectable: false,
      draggable: false,
    });
  }
  nodes.push(...ghostNodes(store));
  return nodes;
}

/** Outlines of a previewed layout: every window and region that would move, where it would go. */
function ghostNodes(store: CanvasStore): Node[] {
  const ghost = store.ghost;
  if (!ghost) return [];
  const current = store.layoutState;
  const visible = store.visibleTileIds();
  const nodes: Node[] = [];
  const same = (a: TileRect | undefined, b: TileRect) =>
    a !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  for (const [id, region] of Object.entries(ghost.state.regions)) {
    const rect = regionFootprint(region);
    const before = current.regions[id];
    if (before && same(regionFootprint(before), rect)) continue;
    nodes.push({
      ...tileNode('ghost', rect, `ghost:${id}`, { label: region.name, region: true }),
      zIndex: 2000,
      selectable: false,
      draggable: false,
      style: { pointerEvents: 'none' },
    });
  }
  for (const [id, rect] of Object.entries(ghost.state.tiles)) {
    if (!visible.has(id) || same(current.tiles[id], rect)) continue;
    nodes.push({
      ...tileNode('ghost', rect, `ghost:${id}`, { label: store.windowName(id), region: false }),
      zIndex: 2001,
      selectable: false,
      draggable: false,
      style: { pointerEvents: 'none' },
    });
  }
  return nodes;
}

function mergeNodes(previous: Node[], next: Node[]): Node[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  return next.map((node) => {
    const existing = byId.get(node.id);
    if (!existing) return node;
    if (existing.dragging || existing.resizing) return existing;
    return {
      ...existing,
      position: node.position,
      width: node.width,
      height: node.height,
      zIndex: node.zIndex,
      style: node.style,
      // A window that starts or stops visiting a desk changes whether it can be dragged.
      draggable: node.draggable,
      selectable: node.selectable,
    };
  });
}

const minimapColor = (node: Node): string => {
  if (node.type === 'frame' || node.type === 'ghost') return 'transparent';
  const store = getCanvasStore();
  if (node.type === 'region') {
    return regionStyle(store.regionEntry(node.id)?.color).fill;
  }
  const entry = node.type === 'agent' ? store.entryForTile(node.id) : undefined;
  switch (entry?.status) {
    case 'working':
      return '#3b82f6';
    case 'awaiting-input':
      return '#f59e0b';
    case 'error':
      return '#ef4444';
    case 'completed':
      return '#22c55e';
    default:
      if (node.type === 'browser') return '#8b5cf6';
      if (node.type === 'doc') return '#14b8a6';
      return node.type === 'note' ? '#d6b656' : '#8a8a8a';
  }
};

type GroupDrag = {
  nodeId: string;
  start: { x: number; y: number };
  followers: Map<string, { x: number; y: number }>;
};

/** Selected windows and regions of a view (task frames and ghosts are never part of a selection). */
function selectedIds(nodes: readonly Node[]): string[] {
  return nodes
    .filter((node) => node.type !== 'frame' && node.type !== 'ghost' && node.type !== 'scrim')
    .map((node) => node.id);
}

/**
 * One view of the board. The single canvas is view 0; multi-canvas mounts one per view, each with
 * its own camera over the same windows. Only the active view takes viewport commands and owns the
 * selection and the board scope.
 */
const Board = observer(function Board({
  container,
  pane,
}: {
  container: HTMLDivElement | null;
  pane: number;
}) {
  const store = getCanvasStore();
  const flow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [animating, setAnimating] = useState(false);
  const multi = store.multiCanvas;
  const active = store.activePane === pane;
  const locked = store.proMode && store.deskLocked;

  useEffect(
    () =>
      reaction(
        () => buildNodes(store, pane),
        (next) => setNodes((previous) => mergeNodes(previous, next)),
        { fireImmediately: true, equals: comparer.structural }
      ),
    [store, pane, setNodes]
  );

  // The view that becomes active brings its own selection with it.
  useEffect(
    () =>
      reaction(
        () => store.activePane === pane,
        (isActive) => {
          if (isActive) store.setSelection(selectedIds(flow.getNodes().filter((n) => n.selected)));
        }
      ),
    [store, pane, flow]
  );

  // Apply focus/fit requests coming from commands, the toolbar, and the voice conductor.
  useEffect(
    () =>
      reaction(
        () => store.viewportCommand,
        (command) => {
          if (!command || store.activePane !== pane) return;
          store.consumeViewportCommand(command.id);
          switch (command.kind) {
            case 'focus': {
              const rect = isRegionId(command.tileId)
                ? store.regionEntry(command.tileId)?.rect
                : store.tileRect(command.tileId);
              if (!rect) return;
              void flow.setCenter(rect.x + rect.w / 2, rect.y + rect.h / 2, {
                zoom: 1,
                duration: FOCUS_ANIMATION_MS,
              });
              return;
            }
            case 'fit':
              void flow.fitView({
                nodes: command.tileIds?.map((id) => ({ id })),
                padding: 0.12,
                duration: FOCUS_ANIMATION_MS,
                maxZoom: 1,
              });
              return;
            case 'frame': {
              // The sub-canvas fills the screen below the toolbar; screen-sized ones land at zoom 1.
              const rect = store.regionEntry(command.regionId)?.rect;
              if (!rect) return;
              const viewport = frameViewport(rect, store.boardSize);
              store.setScopeFramedZoom(viewport.zoom);
              // A desk swap is a cut: nothing travels across a board the user never sees.
              void flow.setViewport(viewport, {
                duration: command.instant ? 0 : SCOPE_ANIMATION_MS,
              });
              return;
            }
            case 'restore':
              void flow.setViewport(command.viewport, { duration: SCOPE_ANIMATION_MS });
              return;
          }
        },
        { fireImmediately: true }
      ),
    [store, flow, pane]
  );

  // Layout changes that did not come from the pointer glide into place, and their targets glow.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const dispose = reaction(
      () => store.lastChange,
      (change) => {
        if (!change || change.source === 'pointer') return;
        setAnimating(true);
        timers.push(setTimeout(() => setAnimating(false), LAYOUT_ANIMATION_MS));
        const targets = new Set([...change.targets, ...change.displaced]);
        if (targets.size === 0) return;
        setNodes((current) =>
          current.map((node) => (targets.has(node.id) ? { ...node, className: FLASH_CLASS } : node))
        );
        timers.push(
          setTimeout(
            () =>
              setNodes((current) =>
                current.map((node) =>
                  node.className === FLASH_CLASS ? { ...node, className: undefined } : node
                )
              ),
            FLASH_MS
          )
        );
      }
    );
    return () => {
      dispose();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [store, setNodes]);

  // Canvas Pro: another desk came into view. The swap is a cut, softened by a quick fade.
  useEffect(
    () =>
      reaction(
        () => store.activeDeskId,
        (desk, previous) => {
          if (!desk || !previous || !container || prefersReducedMotion()) return;
          container
            .querySelector('.react-flow__viewport')
            ?.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: DESK_SWAP_MS,
              easing: 'ease-out',
            });
        }
      ),
    [store, container]
  );

  // The view's size feeds screen-relative sizes ("half the screen") and slot placement.
  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) store.setPaneSize(pane, entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, store, pane]);

  const defaultViewport = useMemo(() => store.paneViewport(pane), [store, pane]);
  // While a task frame or a region is dragged, what is inside it follows.
  const groupDrag = useRef<GroupDrag | null>(null);
  const frameTiles = (frameId: string) =>
    store.taskFrames.find((frame) => frame.frameId === frameId)?.tileIds ?? [];

  const followersOf = (node: Node): Map<string, { x: number; y: number }> | null => {
    const followers = new Map<string, { x: number; y: number }>();
    if (node.type === 'frame') {
      for (const tileId of frameTiles(node.id)) {
        const rect = store.tileRect(tileId);
        followers.set(tileId, { x: rect.x, y: rect.y });
      }
      return followers;
    }
    if (node.type === 'region') {
      const layout = store.layoutState;
      for (const tileId of descendantTiles(layout, node.id)) {
        const rect = store.tileRect(tileId);
        followers.set(tileId, { x: rect.x, y: rect.y });
      }
      for (const regionId of descendantRegions(layout, node.id)) {
        const region = layout.regions[regionId];
        if (region) followers.set(regionId, { x: region.rect.x, y: region.rect.y });
      }
      for (const frame of store.taskFrames) {
        if (frame.tileIds.some((id) => followers.has(id))) {
          followers.set(frame.frameId, { x: frame.rect.x, y: frame.rect.y });
        }
      }
      return followers;
    }
    return null;
  };

  const dropProbe = (node: Node) => {
    const width = node.measured?.width ?? node.width ?? 0;
    const height = node.measured?.height ?? node.height ?? 0;
    return { x: node.position.x + width / 2, y: node.position.y + Math.min(height / 2, 60) };
  };

  return (
    <ReactFlow
      // Per view: React Flow derives its SVG pattern ids from it, and they must not collide.
      id={`chorus-canvas-${pane}`}
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      elevateNodesOnSelect={false}
      onSelectionChange={({ nodes: selected }) => {
        if (store.activePane === pane) store.setSelection(selectedIds(selected));
      }}
      // Panning or zooming a view (also by wheel, without a click) makes it the active one.
      onMoveStart={(event) => {
        if (event) store.activatePane(pane);
      }}
      onNodeDragStart={(_event, node) => {
        const followers = followersOf(node);
        groupDrag.current = followers
          ? { nodeId: node.id, start: { ...node.position }, followers }
          : null;
      }}
      onNodeDrag={(_event, node) => {
        const drag = groupDrag.current;
        if (drag && drag.nodeId === node.id) {
          const dx = node.position.x - drag.start.x;
          const dy = node.position.y - drag.start.y;
          setNodes((current) =>
            current.map((candidate) => {
              const origin = drag.followers.get(candidate.id);
              return origin
                ? { ...candidate, position: { x: origin.x + dx, y: origin.y + dy } }
                : candidate;
            })
          );
        }
        if (node.type === 'frame') return;
        const hint = store.dropRegionAt(dropProbe(node), isRegionId(node.id) ? node.id : undefined);
        store.setDropHint(hint && hint !== store.regionOf(node.id) ? hint : null);
      }}
      onNodeDragStop={(_event, node, dragged) => {
        store.setDropHint(null);
        const drag = groupDrag.current;
        groupDrag.current = null;
        if (drag && drag.nodeId === node.id && node.type === 'frame') {
          store.moveTiles(
            frameTiles(node.id),
            node.position.x - drag.start.x,
            node.position.y - drag.start.y
          );
          return;
        }
        const layout = store.layoutState;
        const moved = dragged.filter((item) => item.type !== 'frame' && item.type !== 'ghost');
        const regions = moved.filter((item) => isRegionId(item.id)).map((item) => item.id);
        // Windows inside a dragged region move with it.
        const drops = moved
          .filter(
            (item) =>
              !regions.some((region) => region !== item.id && isWithin(layout, item.id, region))
          )
          .map((item) => ({ id: item.id, x: item.position.x, y: item.position.y }));
        store.dropNodes(drops);
        // A single note dropped onto an agent tile offers to send its text to that agent.
        const [only] = dragged;
        if (dragged.length === 1 && only?.id.startsWith('note:')) store.noteDropped(only.id);
      }}
      onMoveEnd={(event, viewport) => {
        store.setPaneViewport(pane, viewport);
        // Only the user's own pans and zooms leave a sub-canvas; framing it never does.
        if (event && store.activePane === pane) {
          store.cameraMoved(viewportRect(viewport, store.boardSize), viewport.zoom);
        }
      }}
      onPaneClick={(event) => {
        store.focusTile(null);
        // Clicking the receded board outside the sub-canvas steps out of it.
        const scope = store.focusedRegionId;
        const rect = scope ? store.regionEntry(scope)?.rect : undefined;
        if (!rect) return;
        const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const inside =
          at.x >= rect.x && at.x <= rect.x + rect.w && at.y >= rect.y && at.y <= rect.y + rect.h;
        if (!inside) store.leaveScope();
      }}
      onDoubleClick={(event) => {
        // Double-clicking empty canvas drops a note there.
        const target = event.target as HTMLElement;
        const node = target.closest('.react-flow__node');
        if (
          node &&
          !node.classList.contains('react-flow__node-frame') &&
          !node.classList.contains('react-flow__node-region')
        ) {
          return;
        }
        if (target.closest('.chorus-frame-handle, .chorus-region-handle')) return;
        const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        // One action, so the note joins the region it was dropped in before anything else (Canvas
        // Pro puts a window that is on no desk onto one) gives it a place.
        runInAction(() => {
          const noteId = store.addNote('', position);
          // Notes dropped inside a region belong to it.
          const region = store.dropRegionAt(position);
          if (region) {
            store.runLayout(
              [
                {
                  op: 'move',
                  targets: [`note:${noteId}`],
                  to: { kind: 'exact', x: position.x, y: position.y, region },
                },
              ],
              { source: 'pointer' }
            );
          }
        });
      }}
      defaultViewport={defaultViewport}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      zoomOnDoubleClick={false}
      // A desk that fills the screen stays framed: there is no board around it to pan to.
      panOnDrag={!locked}
      zoomOnScroll={!locked}
      zoomOnPinch={!locked}
      autoPanOnNodeDrag={!locked}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      className={cn(
        // Canvas Pro: the desk's backdrop shows through the board.
        store.proMode ? 'chorus-canvas bg-transparent' : 'chorus-canvas bg-background',
        '[&_.chorus-flash]:rounded-2xl [&_.chorus-flash]:shadow-[0_0_0_4px_rgb(59_130_246/0.55),0_0_32px_rgb(59_130_246/0.35)]',
        animating &&
          'motion-safe:[&_.react-flow__node]:transition-[transform,width,height] motion-safe:[&_.react-flow__node]:duration-300 motion-safe:[&_.react-flow__node]:ease-out'
      )}
    >
      {!store.proMode && (
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} className="opacity-40" />
      )}
      {!multi && !store.focusedRegionId && !store.proMode && (
        <MiniMap
          pannable
          zoomable
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          maskColor="rgb(0 0 0 / 0.08)"
          className="!rounded-lg !border !border-border !bg-background-secondary"
          {...overlayProps}
        />
      )}
      {!multi && (
        <Panel position="top-left" {...overlayProps}>
          <CanvasToolbar />
        </Panel>
      )}
      {active && <GhostBanner />}
    </ReactFlow>
  );
});

/** While a large change is previewed: what it does, with apply and cancel. */
const GhostBanner = observer(function GhostBanner() {
  const store = getCanvasStore();
  const ghost = store.ghost;
  if (!ghost) return null;
  return (
    <Panel position="bottom-center" {...overlayProps}>
      <div className="flex max-w-[720px] items-center gap-3 rounded-xl border border-blue-500/40 bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
        <span className="min-w-0 flex-1 text-foreground">{ghost.label}</span>
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-500"
          onClick={() => store.applyGhost()}
        >
          Apply
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
          onClick={() => store.clearGhost()}
        >
          Cancel
        </button>
      </div>
    </Panel>
  );
});

/**
 * Canvas Pro: the desk's own light, a wash of its color behind its windows, so each desk is
 * recognisable at a glance. On a swap it drifts in from the side the new desk lies on.
 */
const DeskBackdrop = observer(function DeskBackdrop() {
  const store = getCanvasStore();
  const desk = store.desks.find((candidate) => candidate.active);
  const ref = useRef<HTMLDivElement | null>(null);
  const previous = useRef<number | null>(null);
  const index = desk?.index ?? null;
  useEffect(() => {
    const from = previous.current;
    previous.current = index;
    if (index === null || from === null || index === from || prefersReducedMotion()) return;
    ref.current?.animate(
      [
        { opacity: 0, translate: `${index > from ? 64 : -64}px 0` },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
  }, [index]);
  if (!desk) return null;
  const fill = regionStyle(desk.color).fill;
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        background: `radial-gradient(80% 65% at 12% 0%, ${fill}, transparent 70%), radial-gradient(70% 60% at 100% 100%, ${fill}, transparent 65%)`,
      }}
    />
  );
});

/**
 * Canvas Pro: desks out of view that need the user light the edge of the screen they lie toward,
 * with a chip that goes there. The one desk on screen never hides work that is waiting elsewhere.
 */
const DeskSignals = observer(function DeskSignals() {
  const store = getCanvasStore();
  const signals = store.deskSignals;
  if (signals.length === 0) return null;
  return (
    <>
      {(['left', 'right'] as const).map((side) => {
        const here = signals.filter((signal) => signal.side === side);
        if (here.length === 0) return null;
        const tint = here.some((signal) => signal.waiting > 0) ? '245 158 11' : '244 63 94';
        const Arrow = side === 'left' ? ChevronLeft : ChevronRight;
        return (
          <div
            key={side}
            className={cn(
              'pointer-events-none absolute inset-y-0 z-10 flex w-44 flex-col justify-center gap-2',
              side === 'left' ? 'left-0 items-start' : 'right-0 items-end'
            )}
          >
            <div
              aria-hidden
              className="absolute inset-0 motion-safe:animate-pulse"
              style={{
                background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgb(${tint} / 0.22), transparent)`,
              }}
            />
            {here.map((signal) => (
              <button
                key={signal.regionId}
                type="button"
                title={`Go to ${signal.name}`}
                onClick={() => store.answerDesk(signal.regionId)}
                className={cn(
                  'pointer-events-auto relative mx-2 flex max-w-40 items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur hover:bg-background-secondary',
                  side === 'right' && 'flex-row-reverse'
                )}
                {...overlayProps}
              >
                <Arrow className="size-3.5 shrink-0 text-foreground-muted" />
                <span className="min-w-0 text-left">
                  <span className="block truncate font-semibold text-foreground">
                    {signal.name}
                  </span>
                  <span className="block truncate text-foreground-muted">
                    {signalLabel(signal)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
});

function signalLabel(signal: { waiting: number; failed: number }): string {
  const parts: string[] = [];
  if (signal.waiting > 0)
    parts.push(`${signal.waiting} need${signal.waiting === 1 ? 's' : ''} you`);
  if (signal.failed > 0) parts.push(`${signal.failed} failed`);
  return parts.join(', ');
}

/** One view's cell: no frame of its own, so neighbouring views meet at the divider line. */
function BoardPane({ pane }: { pane: number }) {
  const store = getCanvasStore();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setContainer}
      className="relative min-h-0 min-w-0 overflow-hidden bg-background"
      onPointerDownCapture={() => store.activatePane(pane)}
    >
      <DeskBackdrop />
      <CanvasPaneContext.Provider value={pane}>
        <ReactFlowProvider>
          <Board container={container} pane={pane} />
        </ReactFlowProvider>
      </CanvasPaneContext.Provider>
    </div>
  );
}

const CanvasSurface = observer(function CanvasSurface() {
  const store = getCanvasStore();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const count = store.paneCount;
  const { columns, rows } = paneGrid(count);

  // Board keyboard: undo/redo, group, nudge, stage, and navigation (never while typing).
  useEffect(() => {
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (container.offsetParent === null) return;
      if (handleCanvasKey(store, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [container, store]);

  return (
    // `isolate`: the stage's z-index must stay inside the canvas. App browser pages are drawn by
    // `BrowserSurfaceHost` at the workspace shell (z-5) and have to paint above the stage.
    <div ref={setContainer} className="relative isolate h-full w-full overflow-hidden">
      {/* The views fill the surface; the grid's own color shows through the gaps as the dividers. */}
      <div
        className={cn('grid h-full w-full bg-border', store.stageActive && 'invisible')}
        style={{
          gap: PANE_DIVIDER,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
        aria-hidden={store.stageActive}
      >
        {Array.from({ length: count }, (_, pane) => (
          // Keyed by the split: changing it remounts every view at its new camera.
          <BoardPane key={`${count}:${pane}`} pane={pane} />
        ))}
      </div>
      {count > 1 &&
        !store.stageActive && (
          // One toolbar for all views, over the split rather than inside a view it would not fit.
          <div className="absolute top-[15px] left-[15px] z-10" {...overlayProps}>
            <CanvasToolbar />
          </div>
        )}
      {store.proMode && !store.stageActive && <DeskSignals />}
      {store.stageActive && <CanvasStage />}
    </div>
  );
});

export function CanvasBoard() {
  return <CanvasSurface />;
}
