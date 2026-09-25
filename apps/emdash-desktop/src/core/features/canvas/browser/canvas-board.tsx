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
import { comparer, reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef } from 'react';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { MAX_ZOOM, MIN_ZOOM } from '../api/canvas-model';
import { getCanvasStore } from '../contributions/browser/app-stores';
import { CanvasToolbar } from './canvas-toolbar';
import { AgentTileNode } from './tiles/agent-tile';
import { BrowserTileNode, CANVAS_OVERLAY_ATTRIBUTE } from './tiles/browser-tile';
import { NoteTileNode } from './tiles/note-tile';
import { TaskFrameNode } from './tiles/task-frame';

const nodeTypes: NodeTypes = {
  agent: AgentTileNode,
  browser: BrowserTileNode,
  note: NoteTileNode,
  frame: TaskFrameNode,
};

const overlayProps = { [CANVAS_OVERLAY_ATTRIBUTE]: '' };

const FOCUS_ANIMATION_MS = 350;

/** Desired node geometry from the store; React Flow keeps selection and drag state. */
function buildNodes(store: CanvasStore): Node[] {
  const nodes: Node[] = [];
  // Frames first and below everything: only their header strip takes pointer input.
  for (const frame of store.taskFrames) {
    nodes.push({
      id: frame.frameId,
      type: 'frame',
      position: { x: frame.rect.x, y: frame.rect.y },
      width: frame.rect.w,
      height: frame.rect.h,
      zIndex: -1,
      selectable: false,
      dragHandle: '.chorus-frame-handle',
      style: { pointerEvents: 'none' },
      data: { frameId: frame.frameId },
    });
  }
  for (const entry of store.visibleAgentEntries) {
    const rect = store.tileRect(entry.tileId);
    nodes.push({
      id: entry.tileId,
      type: 'agent',
      position: { x: rect.x, y: rect.y },
      width: rect.w,
      height: rect.h,
      data: {
        tileId: entry.tileId,
        projectId: entry.projectId,
        taskId: entry.taskId,
        conversationId: entry.conversationId,
      },
    });
  }
  for (const browser of store.visibleBrowserEntries) {
    const rect = store.tileRect(browser.tileId);
    nodes.push({
      id: browser.tileId,
      type: 'browser',
      position: { x: rect.x, y: rect.y },
      width: rect.w,
      height: rect.h,
      data: { tileId: browser.tileId },
    });
  }
  for (const note of store.noteEntries) {
    const rect = store.tileRect(note.tileId);
    nodes.push({
      id: note.tileId,
      type: 'note',
      position: { x: rect.x, y: rect.y },
      width: rect.w,
      height: rect.h,
      data: { tileId: note.tileId, noteId: note.noteId },
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
    return { ...existing, position: node.position, width: node.width, height: node.height };
  });
}

const minimapColor = (node: Node): string => {
  if (node.type === 'frame') return 'transparent';
  const entry = node.type === 'agent' ? getCanvasStore().entryForTile(node.id) : undefined;
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
      return node.type === 'note' ? '#d6b656' : '#8a8a8a';
  }
};

const Board = observer(function Board() {
  const store = getCanvasStore();
  const flow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  useEffect(
    () =>
      reaction(
        () => buildNodes(store),
        (next) => setNodes((previous) => mergeNodes(previous, next)),
        { fireImmediately: true, equals: comparer.structural }
      ),
    [store, setNodes]
  );

  // Apply focus/fit requests coming from commands, the toolbar, and the voice conductor.
  useEffect(
    () =>
      reaction(
        () => store.viewportCommand,
        (command) => {
          if (!command) return;
          store.consumeViewportCommand(command.id);
          if (command.kind === 'focus') {
            const rect = store.tileRect(command.tileId);
            void flow.setCenter(rect.x + rect.w / 2, rect.y + rect.h / 2, {
              zoom: 1,
              duration: FOCUS_ANIMATION_MS,
            });
          } else {
            void flow.fitView({
              nodes: command.tileIds?.map((id) => ({ id })),
              padding: 0.12,
              duration: FOCUS_ANIMATION_MS,
              maxZoom: 1,
            });
          }
        },
        { fireImmediately: true }
      ),
    [store, flow]
  );

  const defaultViewport = useMemo(() => store.viewport, [store]);
  // While a task frame is dragged, its agent tiles follow it.
  const frameDrag = useRef<{
    frameId: string;
    start: { x: number; y: number };
    tiles: Map<string, { x: number; y: number }>;
  } | null>(null);
  const frameTiles = (frameId: string) =>
    store.taskFrames.find((frame) => frame.frameId === frameId)?.tileIds ?? [];

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={(_event, node) => {
        if (node.type !== 'frame') return;
        const tiles = new Map<string, { x: number; y: number }>();
        for (const tileId of frameTiles(node.id)) {
          const rect = store.tileRect(tileId);
          tiles.set(tileId, { x: rect.x, y: rect.y });
        }
        frameDrag.current = { frameId: node.id, start: { ...node.position }, tiles };
      }}
      onNodeDrag={(_event, node) => {
        const drag = frameDrag.current;
        if (!drag || drag.frameId !== node.id) return;
        const dx = node.position.x - drag.start.x;
        const dy = node.position.y - drag.start.y;
        setNodes((current) =>
          current.map((candidate) => {
            const origin = drag.tiles.get(candidate.id);
            return origin
              ? { ...candidate, position: { x: origin.x + dx, y: origin.y + dy } }
              : candidate;
          })
        );
      }}
      onNodeDragStop={(_event, node, dragged) => {
        const drag = frameDrag.current;
        if (drag && drag.frameId === node.id) {
          frameDrag.current = null;
          store.moveTiles(
            [...drag.tiles.keys()],
            node.position.x - drag.start.x,
            node.position.y - drag.start.y
          );
          return;
        }
        for (const node of dragged) {
          if (node.type !== 'frame') store.setTileRect(node.id, node.position);
        }
        // A single note dropped onto an agent tile offers to send its text to that agent.
        const [only] = dragged;
        if (dragged.length === 1 && only?.id.startsWith('note:')) store.noteDropped(only.id);
      }}
      onMoveEnd={(_event, viewport) => store.setViewport(viewport)}
      onPaneClick={() => store.focusTile(null)}
      onDoubleClick={(event) => {
        // Double-clicking empty canvas drops a note there.
        const target = event.target as HTMLElement;
        const node = target.closest('.react-flow__node');
        if (node && !node.classList.contains('react-flow__node-frame')) return;
        if (target.closest('.chorus-frame-handle')) return;
        const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        store.addNote('', position);
      }}
      defaultViewport={defaultViewport}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      zoomOnDoubleClick={false}
      onlyRenderVisibleElements
      proOptions={{ hideAttribution: true }}
      className="chorus-canvas bg-background"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} className="opacity-40" />
      <MiniMap
        pannable
        zoomable
        nodeColor={minimapColor}
        nodeStrokeWidth={0}
        maskColor="rgb(0 0 0 / 0.08)"
        className="!rounded-lg !border !border-border !bg-background-secondary"
        {...overlayProps}
      />
      <Panel position="top-left" {...overlayProps}>
        <CanvasToolbar />
      </Panel>
    </ReactFlow>
  );
});

export function CanvasBoard() {
  return (
    <ReactFlowProvider>
      <div className="relative h-full w-full">
        <Board />
      </div>
    </ReactFlowProvider>
  );
}
