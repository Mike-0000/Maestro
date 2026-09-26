import { AgentStatus } from '@emdash/ui/react/components';
import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { EyeOff, Maximize2, PanelsTopLeft, Play } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import {
  needsAttention,
  type AgentTileEntry,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  DEFAULT_LIVE_TILE_BUDGET,
  detailZoomForBand,
  MIN_TILE_SIZE,
  resolveTileDetail,
  zoomBand,
} from '../../api/canvas-model';
import { outsideLiveBudget } from '../../api/region-tiling';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { AgentAcpLive, AgentAcpPreview } from './agent-acp';
import { AgentPreview } from './agent-preview';
import { AgentTerminal, TerminalPlaceholder } from './agent-terminal';
import { statusPresentation } from './status-presentation';

export type AgentTileData = {
  tileId: string;
  projectId: string;
  taskId: string;
  conversationId: string;
};

export const AgentTileNode = observer(function AgentTileNode({ data, selected }: NodeProps) {
  const { tileId, projectId, taskId, conversationId } = data as AgentTileData;
  const store = getCanvasStore();
  const entry =
    store.entryForConversation(projectId, taskId, conversationId) ?? store.entryForTile(tileId);
  // Subscribe to zoom bands, not raw zoom, so pan/zoom does not re-render every tile per frame.
  const band = useStore((state) => zoomBand(state.transform[2]));

  if (!entry) return null;

  // Windows of the sub-canvas the user is in render fully; the rest of the board shares what is
  // left of the usual live budget, by their own focus order.
  const promoted = store.isPromoted(tileId);
  const detail = resolveTileDetail({
    zoom: detailZoomForBand(band),
    // onlyRenderVisibleElements unmounts off-screen nodes; a mounted tile is visible.
    visible: true,
    focusRank: store.outsideFocusRank(tileId),
    liveBudget: outsideLiveBudget(DEFAULT_LIVE_TILE_BUDGET, store.promotedTileIds.length),
    hasSession: store.shouldAttach(entry),
    promoted,
  });
  const focused = store.focusedTileId === tileId;
  const attention = needsAttention(entry);
  // A staged agent is mounted on the stage; mounting its terminal here too would fight over it.
  const staged = store.isStaged(tileId);
  const badge = store.listening && store.layoutSettings.showNamesWhileListening;

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-xl border bg-background shadow-lg transition-[box-shadow,border-color]',
        focused ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-border',
        attention && !focused && 'border-amber-500/70 ring-2 ring-amber-500/30'
      )}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && band !== 'glyph'}
        minWidth={MIN_TILE_SIZE.w}
        minHeight={MIN_TILE_SIZE.h}
        lineClassName="!border-blue-500/60"
        handleClassName="!size-2.5 !rounded-sm !border-blue-500 !bg-background"
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <AgentTileHeader entry={entry} glyph={band === 'glyph'} />
      <div className="relative min-h-0 flex-1">
        {badge && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <span className="rounded-2xl bg-background/90 px-6 py-2 text-5xl font-bold tracking-tight text-foreground shadow-lg">
              {store.spokenName(conversationId)}
            </span>
          </div>
        )}
        {staged ? (
          <TerminalPlaceholder label="On the stage" />
        ) : detail === 'glyph' ? (
          <AgentGlyph entry={entry} />
        ) : !store.shouldAttach(entry) ? (
          <ResumePrompt entry={entry} />
        ) : entry.type === 'acp' ? (
          detail === 'live' ? (
            <AgentAcpLive
              entry={entry}
              interactive={band === 'interactive'}
              onActivate={() => store.requestFocus(tileId)}
            />
          ) : (
            <AgentAcpPreview entry={entry} onActivate={() => store.requestFocus(tileId)} />
          )
        ) : detail === 'live' ? (
          <AgentTerminal
            entry={entry}
            hydrate={!entry.sessionActive && store.startRequested.has(entry.conversationId)}
            interactive={band === 'interactive'}
            autoFocus={focused}
            onActivate={() => store.requestFocus(tileId)}
            onReleaseFocus={() => store.reframe()}
          />
        ) : (
          <AgentPreview entry={entry} onActivate={() => store.requestFocus(tileId)} />
        )}
      </div>
    </div>
  );
});

const AgentTileHeader = observer(function AgentTileHeader({
  entry,
  glyph,
}: {
  entry: AgentTileEntry;
  glyph: boolean;
}) {
  const store = getCanvasStore();
  const [renaming, setRenaming] = useState(false);
  const spokenName = store.spokenName(entry.conversationId);
  const presentation = statusPresentation(entry);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border bg-background-secondary px-3',
        glyph ? 'h-16' : 'h-10'
      )}
    >
      <AgentIcon id={entry.providerId} size={glyph ? 28 : 16} />
      {renaming ? (
        <input
          autoFocus
          defaultValue={spokenName}
          aria-label="Agent name"
          className="nodrag w-32 rounded border border-border bg-background px-1 text-sm font-semibold text-foreground outline-none"
          onBlur={(event) => {
            store.setSpokenName(entry.conversationId, event.currentTarget.value);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          type="button"
          title="Double-click to rename. This is the name you say to address this agent."
          className={cn(
            'nodrag shrink-0 truncate font-semibold text-foreground',
            glyph ? 'text-2xl' : 'text-sm'
          )}
          onDoubleClick={() => setRenaming(true)}
        >
          {spokenName}
        </button>
      )}
      {!glyph && (
        <span className="min-w-0 truncate text-xs text-foreground-muted">
          {entry.taskName} · {entry.projectName}
        </span>
      )}
      <span className="flex-1" />
      {!glyph && (entry.linesAdded > 0 || entry.linesDeleted > 0) && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{entry.linesAdded}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{entry.linesDeleted}</span>
        </span>
      )}
      {!glyph && <InsightPill conversationId={entry.conversationId} status={entry.status} />}
      <span
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-medium',
          glyph ? 'text-base' : 'text-[11px]',
          presentation.className
        )}
      >
        <AgentStatus status={entry.status} size={glyph ? 18 : 12} />
        {presentation.label}
      </span>
      {!glyph && (
        <span className="flex shrink-0 items-center gap-0.5">
          <TileIconButton label="Focus (100 %)" onClick={() => store.requestFocus(entry.tileId)}>
            <Maximize2 className="size-3.5" />
          </TileIconButton>
          <TileIconButton
            label="Open in task view"
            onClick={() =>
              getNavigation().navigate(
                taskViewDef({ projectId: entry.projectId, taskId: entry.taskId })
              )
            }
          >
            <PanelsTopLeft className="size-3.5" />
          </TileIconButton>
          <TileIconButton
            label="Hide from canvas (the agent keeps running)"
            onClick={() => store.hideConversation(entry.conversationId)}
          >
            <EyeOff className="size-3.5" />
          </TileIconButton>
        </span>
      )}
    </div>
  );
});

function TileIconButton({
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

const AgentGlyph = observer(function AgentGlyph({ entry }: { entry: AgentTileEntry }) {
  const presentation = statusPresentation(entry);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background-secondary">
      <span className={cn('rounded-2xl px-6 py-3 text-4xl font-semibold', presentation.className)}>
        {presentation.label}
      </span>
      <span className="max-w-[90%] truncate text-2xl text-foreground-muted">{entry.taskName}</span>
    </div>
  );
});

const ResumePrompt = observer(function ResumePrompt({ entry }: { entry: AgentTileEntry }) {
  const store = getCanvasStore();
  if (store.startRequested.has(entry.conversationId)) {
    return <TerminalPlaceholder label="Starting agent…" />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-(--xterm-bg)">
      <span className="text-xs text-foreground-muted">
        {entry.taskProvisioned ? 'This agent is not running.' : 'This task workspace is asleep.'}
      </span>
      <button
        type="button"
        onClick={() => store.resumeAgent(entry)}
        className="nodrag flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background-secondary"
      >
        <Play className="size-3.5" />
        Resume agent
      </button>
    </div>
  );
});

const RISK_PRESENTATION = {
  low: { label: 'Low risk', className: 'bg-green-500/15 text-green-700 dark:text-green-300' },
  moderate: { label: 'Edits files', className: 'bg-foreground/5 text-foreground-muted' },
  elevated: {
    label: 'Side effects',
    className: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
  },
  high: { label: 'High risk', className: 'bg-red-500/15 text-red-700 dark:text-red-300' },
} as const;

/** Jev's read on a pending permission request, shown next to the status pill. */
const InsightPill = observer(function InsightPill({
  conversationId,
  status,
}: {
  conversationId: string;
  status: AgentTileEntry['status'];
}) {
  const insight = getCanvasStore().insight(conversationId);
  if (!insight?.riskLevel || status !== 'awaiting-input') return null;
  const presentation = RISK_PRESENTATION[insight.riskLevel];
  return (
    <span
      title="Jev's estimate of how risky it is to approve this agent's pending request"
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
        presentation.className
      )}
    >
      {presentation.label}
    </span>
  );
});
