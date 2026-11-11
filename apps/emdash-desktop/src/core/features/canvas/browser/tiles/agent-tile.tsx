import { EmptyState, StateGlyph } from '@emdash/ui/react/components';
import { Button, Input, RelativeTime, toast } from '@emdash/ui/react/primitives';
import { NodeResizer, useStore, type NodeProps } from '@xyflow/react';
import { EyeOff, Maximize2, PanelsTopLeft, Phone } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { type AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import { MIN_TILE_SIZE, zoomBand } from '../../api/canvas-model';
import { getCanvasStore } from '../../contributions/browser/app-stores';
import { useIsLivePane } from '../canvas-pane-context';
import {
  LARGE_STATE_GLYPH,
  RESIZE_HANDLE_CLASS,
  SPOKEN_NAME_BADGE,
  WINDOW_ACTIONS,
  WINDOW_FRAME,
  WINDOW_HEADER,
} from '../canvas-styles';
import { AgentAcpLive } from './agent-acp';
import { AgentTerminal, AgentTerminalMirror, TerminalPlaceholder } from './agent-terminal';
import { statusPresentation } from './status-presentation';
import { TileIconButton } from './tile-icon-button';

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
  // Multi-canvas: an agent showing in several views has its real terminal in one of them and a
  // read-only copy that follows it in the others.
  const live = useIsLivePane(tileId);

  if (!entry) return null;

  // Every tile on the board renders its agent live (terminal or chat) at any zoom; pointer input
  // reaches the terminal only at zoom 1.
  const focused = store.focusedTileId === tileId;
  // The conductor is delivering this agent's call. A mark only: focus stays where it was.
  const onLine = store.insight(conversationId)?.onLine === true;
  // A staged agent is mounted on the stage; mounting its terminal here too would fight over it.
  const staged = store.isStaged(tileId);
  const badge = store.listening && store.layoutSettings.showNamesWhileListening;
  const { yours } = statusPresentation(entry);

  return (
    <div
      className={cn(
        WINDOW_FRAME,
        // No coloured chrome: the edge firms up for what is the developer's and for the call on
        // the line, turns the accent for the window with focus, and red only for an error.
        yours && 'border-border-1',
        entry.status === 'error' && 'border-foreground-error/60',
        onLine && 'border-foreground-muted',
        focused && 'border-ring'
      )}
      onPointerDownCapture={() => store.focusTile(tileId)}
    >
      <NodeResizer
        isVisible={selected && band !== 'glyph'}
        minWidth={MIN_TILE_SIZE.w}
        minHeight={MIN_TILE_SIZE.h}
        handleClassName={RESIZE_HANDLE_CLASS}
        onResizeEnd={(_event, params) =>
          store.resizeTile(tileId, { x: params.x, y: params.y, w: params.width, h: params.height })
        }
      />
      <AgentTileHeader entry={entry} glyph={band === 'glyph'} onLine={onLine} />
      <div className="relative min-h-0 flex-1">
        {badge && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <span className={SPOKEN_NAME_BADGE}>{store.spokenName(conversationId)}</span>
          </div>
        )}
        {staged ? (
          <TerminalPlaceholder label="On the stage" />
        ) : !store.shouldAttach(entry) ? (
          <ResumePrompt entry={entry} />
        ) : entry.type === 'acp' ? (
          <AgentAcpLive
            entry={entry}
            interactive={live && band === 'interactive'}
            onActivate={() => store.requestFocus(tileId)}
          />
        ) : !live ? (
          <AgentTerminalMirror entry={entry} />
        ) : (
          <AgentTerminal
            entry={entry}
            hydrate={!entry.sessionActive && store.startRequested.has(entry.conversationId)}
            interactive={band === 'interactive'}
            autoFocus={focused}
            onActivate={() => store.requestFocus(tileId)}
            onReleaseFocus={() => store.reframe()}
          />
        )}
      </div>
    </div>
  );
});

/**
 * The window's title bar reads like the agent's sidebar row: its name, task · project, its state
 * in the kit's marks and words, and how long ago you last wrote to it. Actions show on hover.
 */
const AgentTileHeader = observer(function AgentTileHeader({
  entry,
  glyph,
  onLine,
}: {
  entry: AgentTileEntry;
  glyph: boolean;
  onLine: boolean;
}) {
  const store = getCanvasStore();
  const [renaming, setRenaming] = useState(false);
  const spokenName = store.spokenName(entry.conversationId);
  const presentation = statusPresentation(entry);
  const lastTouched = entry.lastInteractedAt ?? entry.createdAt;

  return (
    <div className={cn(WINDOW_HEADER, glyph ? 'h-16 gap-3 px-4' : 'h-10 pr-1.5 pl-3')}>
      <AgentIcon id={entry.providerId} size={glyph ? 28 : 16} />
      {renaming ? (
        <Input
          autoFocus
          size="sm"
          defaultValue={spokenName}
          aria-label="Agent name"
          className="nodrag w-32 shrink-0 text-sm font-medium"
          onBlur={(event) => {
            const wanted = event.currentTarget.value.trim();
            if (wanted && !store.setSpokenName(entry.conversationId, wanted)) {
              toast.error(`Another agent is already called ${wanted}`, {
                description: 'Each agent needs its own name so you can address it by voice.',
              });
            }
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
            'nodrag max-w-[50%] shrink-0 truncate rounded-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            glyph ? 'text-2xl font-medium' : 'text-sm',
            !glyph && presentation.yours && 'font-medium'
          )}
          onDoubleClick={() => setRenaming(true)}
        >
          {spokenName}
        </button>
      )}
      {!glyph && (
        <span className="min-w-0 truncate text-xs text-foreground-passive">
          {entry.taskName} · {entry.projectName}
        </span>
      )}
      <span className="flex-1" />
      {!glyph && (entry.linesAdded > 0 || entry.linesDeleted > 0) && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs tabular-nums"
          aria-label={`${entry.linesAdded} lines added, ${entry.linesDeleted} lines removed`}
        >
          <span className="text-foreground-diff-added">+{entry.linesAdded}</span>
          <span className="text-foreground-diff-deleted">−{entry.linesDeleted}</span>
        </span>
      )}
      {!glyph && onLine && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-foreground">
          <Phone className="size-3 text-foreground-muted" aria-hidden />
          On the line
        </span>
      )}
      {!glyph && <InsightPill conversationId={entry.conversationId} status={entry.status} />}
      <span
        className={cn(
          'flex shrink-0 items-center whitespace-nowrap',
          glyph ? 'gap-3 text-xl text-foreground-muted' : 'gap-1.5 text-xs text-foreground-muted',
          presentation.yours && 'text-foreground'
        )}
      >
        <StateGlyph state={presentation.glyph} className={glyph ? LARGE_STATE_GLYPH : undefined} />
        {presentation.label}
      </span>
      {!glyph && lastTouched && (
        <RelativeTime
          value={lastTouched}
          compact
          className="shrink-0 text-tiny text-foreground-passive tabular-nums"
        />
      )}
      {!glyph && (
        <span className={WINDOW_ACTIONS}>
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

/** An agent that is not running: what is wrong in a few words, and the one way to start it. */
export const ResumePrompt = observer(function ResumePrompt({ entry }: { entry: AgentTileEntry }) {
  const store = getCanvasStore();
  if (store.startRequested.has(entry.conversationId)) {
    return <TerminalPlaceholder label="Starting agent…" />;
  }
  return (
    <EmptyState
      bare
      className="bg-(--xterm-bg)"
      label={entry.taskProvisioned ? 'This agent is not running' : 'This task workspace is asleep'}
      action={
        <Button
          type="button"
          variant="text"
          className="nodrag"
          onClick={() => store.resumeAgent(entry)}
        >
          Resume agent
        </Button>
      }
    />
  );
});

const RISK_PRESENTATION = {
  low: { label: 'Low risk', className: 'text-foreground-muted' },
  moderate: { label: 'Edits files', className: 'text-foreground-muted' },
  elevated: { label: 'Side effects', className: 'text-foreground-warning' },
  high: { label: 'High risk', className: 'text-foreground-error' },
} as const;

/** Jev's read on a pending permission request, in words next to the state (colour only to warn). */
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
      className={cn('shrink-0 text-xs whitespace-nowrap', presentation.className)}
    >
      {presentation.label}
    </span>
  );
});
