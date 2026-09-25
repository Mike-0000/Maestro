import { BellRing, Eye, Group, Maximize, StickyNote } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { cn } from '@core/primitives/styling/browser/cn';
import { getCanvasStore } from '../contributions/browser/app-stores';

export const CanvasToolbar = observer(function CanvasToolbar() {
  const store = getCanvasStore();
  const attention = store.attentionEntries.length;
  const hidden = store.state.hiddenConversationIds.length;
  const working = store.visibleAgentEntries.filter((entry) => entry.status === 'working').length;

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
        <ToolbarButton
          label="Show hidden agents"
          onClick={() => {
            for (const id of [...store.state.hiddenConversationIds]) store.showConversation(id);
          }}
        >
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
