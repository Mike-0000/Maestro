import {
  BellRing,
  Boxes,
  Eye,
  Group,
  LayoutPanelTop,
  Maximize,
  Redo2,
  SquareDashed,
  StickyNote,
  Undo2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { cn } from '@core/primitives/styling/browser/cn';
import type { OrganizeBy } from '../api/canvas-layout';
import { getCanvasStore } from '../contributions/browser/app-stores';

const ORGANIZE_OPTIONS: { value: OrganizeBy | 'tidy'; label: string }[] = [
  { value: 'tidy', label: 'Tidy up' },
  { value: 'task', label: 'Group by task' },
  { value: 'project', label: 'Group by project' },
  { value: 'status', label: 'Group by status' },
  { value: 'provider', label: 'Group by agent type' },
];

export const CanvasToolbar = observer(function CanvasToolbar() {
  const store = getCanvasStore();
  const attention = store.attentionEntries.length;
  const hidden = store.state.hiddenConversationIds.length;
  const working = store.visibleAgentEntries.filter((entry) => entry.status === 'working').length;
  const selected = store.selection.length;
  const scope = store.currentRegion();

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 text-xs shadow-md backdrop-blur">
      <select
        aria-label="Project filter"
        value={store.projectFilter ?? ''}
        onChange={(event) => store.setProjectFilter(event.currentTarget.value || null)}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
      >
        <option value="">All projects</option>
        {store.projectOptions.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <ToolbarButton label="Fit all agents" onClick={() => store.requestFit()}>
        <Maximize className="size-3.5" />
        Fit
      </ToolbarButton>
      <ToolbarButton label="Add a note" onClick={() => store.addNote()}>
        <StickyNote className="size-3.5" />
        Note
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        label={store.undoLabel ? `Undo: ${store.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        onClick={() => store.undo()}
        disabled={!store.canUndo}
      >
        <Undo2 className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label={store.redoLabel ? `Redo: ${store.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
        onClick={() => store.redo()}
        disabled={!store.canRedo}
      >
        <Redo2 className="size-3.5" />
      </ToolbarButton>
      <select
        aria-label="Organize the board"
        title={scope ? 'Organize the windows in this region' : 'Organize the board'}
        value=""
        onChange={(event) => {
          const value = event.currentTarget.value as OrganizeBy | 'tidy' | '';
          if (!value) return;
          store.runLayout(
            [
              value === 'tidy'
                ? { op: 'arrange', targets: null, scope, layout: 'tidy' }
                : { op: 'organize', scope, by: value },
            ],
            { source: 'command', allowPreview: true }
          );
        }}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none"
      >
        <option value="">Organize…</option>
        {ORGANIZE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ToolbarButton
        label={
          selected > 0
            ? 'Group the selected windows into a region (Ctrl+G)'
            : 'New empty region (select windows first to group them)'
        }
        onClick={() => {
          if (selected > 0) store.groupSelection();
          else {
            const result = store.runLayout([{ op: 'createRegion', members: [] }], {
              source: 'command',
            });
            const created = result.ok ? result.plan.created[0] : undefined;
            if (created) store.setRenamingRegion(created);
          }
        }}
      >
        {selected > 0 ? <Boxes className="size-3.5" /> : <SquareDashed className="size-3.5" />}
        {selected > 0 ? `Group ${selected}` : 'Region'}
      </ToolbarButton>
      <ToolbarButton
        label="Open the selection, or the region in view, on the stage (Ctrl+Enter)"
        onClick={() => store.stageSelection()}
        disabled={selected === 0 && !scope && !store.focusedTileId}
      >
        <LayoutPanelTop className="size-3.5" />
        Stage
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        label="Jump to the agent that has waited longest for you"
        onClick={() => store.focusNextAttention()}
        disabled={attention === 0}
        className={attention > 0 ? 'text-amber-700 dark:text-amber-300' : undefined}
      >
        <BellRing className="size-3.5" />
        {attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : 'All clear'}
      </ToolbarButton>
      <ToolbarButton
        label={store.showTaskFrames ? 'Hide task frames' : 'Show task frames'}
        onClick={() => store.setShowTaskFrames(!store.showTaskFrames)}
        className={store.showTaskFrames ? undefined : 'text-foreground-muted'}
      >
        <Group className="size-3.5" />
        Frames
      </ToolbarButton>
      {hidden > 0 && (
        <ToolbarButton label="Show hidden agents" onClick={() => store.showAllConversations()}>
          <Eye className="size-3.5" />
          {hidden} hidden
        </ToolbarButton>
      )}
      <span className="px-2 text-foreground-muted tabular-nums">
        {store.visibleAgentEntries.length} agents · {working} working
      </span>
    </div>
  );
});

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" />;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-foreground hover:bg-background-secondary disabled:opacity-50 disabled:hover:bg-transparent',
        className
      )}
    >
      {children}
    </button>
  );
}
