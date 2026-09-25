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
import { useEffect, useMemo } from 'react';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { MAX_ZOOM, MIN_ZOOM } from '../api/canvas-model';
import { getCanvasStore } from '../contributions/browser/app-stores';
import { CanvasToolbar } from './canvas-toolbar';
import { AgentTileNode } from './tiles/agent-tile';
import { NoteTileNode } from './tiles/note-tile';

const nodeTypes: NodeTypes = { agent: AgentTileNode, note: NoteTileNode };

const FOCUS_ANIMATION_MS = 350;

/** Desired node geometry from the store; React Flow keeps selection and drag state. */
function buildNodes(store: CanvasStore): Node[] {
  const nodes: Node[] = [];
  for (const entry of store.visibleAgentEntries) {
    const rect = store.tileRect(entry.tileId);
    nodes.push({
      id: entry.tileId,
      type: 'agent',
      position: { x: rect.x, y: rect.y },
      width: rect.w,
      height: rect.h,
      data: { tileId: entry.tileId },
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

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_event, _node, dragged) => {
        for (const node of dragged) store.setTileRect(node.id, node.position);
        // A single note dropped onto an agent tile offers to send its text to that agent.
        const [only] = dragged;
        if (dragged.length === 1 && only?.id.startsWith('note:')) store.noteDropped(only.id);
      }}
      onMoveEnd={(_event, viewport) => store.setViewport(viewport)}
      onPaneClick={() => store.focusTile(null)}
      onDoubleClick={(event) => {
        // Double-clicking empty canvas drops a note there.
        if ((event.target as HTMLElement).closest('.react-flow__node')) return;
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
      />
      <Panel position="top-left">
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
