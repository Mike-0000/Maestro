import { EmptyState } from '@emdash/ui/react/components';
import { Combobox, Spinner, Tooltip } from '@emdash/ui/react/primitives';
import { ChevronsUpDown, FolderGit2, GitBranch, Link } from 'lucide-react';
import { useState } from 'react';
import type { ProjectWorkspaceOption } from '@core/features/tasks/api/browser/create-task-modal/project-workspace-options';
import { cn } from '@core/primitives/styling/browser/cn';
import { FIELD_TRIGGER_CLASS } from './field-trigger';

function workspaceLabel(ws: ProjectWorkspaceOption): string {
  if (ws.kind === 'repository') return 'Repository root';
  if (ws.path) {
    const lastSegment = ws.path.split('/').at(-1);
    return lastSegment || (ws.branchName ?? ws.workspaceId ?? ws.path);
  }
  return ws.branchName ?? ws.workspaceId ?? ws.path;
}

/** Two lines: the workspace's name with its facts, then its path (or why it is unavailable). */
function WorkspaceItemContent({ ws }: { ws: ProjectWorkspaceOption }) {
  const isRoot = ws.kind === 'repository';
  const label = workspaceLabel(ws);
  const hasDiff = ws.linesAdded != null || ws.linesDeleted != null;

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-passive">
          {isRoot ? <FolderGit2 className="size-3.5" /> : <GitBranch className="size-3.5" />}
        </span>
        <span className="truncate text-sm text-foreground">{label}</span>
        {hasDiff && (
          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
            {ws.linesAdded != null && (
              <span className="text-foreground-diff-added">+{ws.linesAdded}</span>
            )}
            {ws.linesDeleted != null && (
              <span className="text-foreground-diff-deleted">−{ws.linesDeleted}</span>
            )}
          </span>
        )}
        {ws.linkedTaskCount > 0 && (
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger className="flex shrink-0 items-center gap-0.5 text-xs text-foreground-passive tabular-nums">
                <Link className="size-3" />
                {ws.linkedTaskCount}
              </Tooltip.Trigger>
              <Tooltip.Content>
                {ws.linkedTaskCount === 1
                  ? '1 associated task'
                  : `${ws.linkedTaskCount} associated tasks`}
              </Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}
      </span>
      <span
        className={cn(
          'truncate pl-5.5 text-left text-xs',
          ws.disabledReason ? 'text-foreground-warning' : 'text-foreground-passive'
        )}
      >
        {ws.disabledReason ?? ws.path}
      </span>
    </span>
  );
}
interface ExistingWorkspacePickerProps {
  workspaces: ProjectWorkspaceOption[];
  isLoading: boolean;
  selectedWorkspaceId: string | null;
  onSelect: (workspaceId: string) => void;
}

export function ExistingWorkspacePicker({
  workspaces,
  isLoading,
  selectedWorkspaceId,
  onSelect,
}: ExistingWorkspacePickerProps) {
  const [query, setQuery] = useState('');

  const selected = workspaces.find((ws) => ws.workspaceId === selectedWorkspaceId) ?? null;

  const filtered = query
    ? workspaces.filter((ws) => {
        const q = query.toLowerCase();
        return workspaceLabel(ws).toLowerCase().includes(q) || ws.path.toLowerCase().includes(q);
      })
    : workspaces;

  if (isLoading) {
    return (
      <div role="status" className="flex h-8 items-center gap-2 text-xs text-foreground-muted">
        <Spinner size="sm" className="text-foreground-passive" />
        Loading workspaces…
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <p className="text-xs text-foreground-muted">
        This project has no other workspaces yet. Pick a new worktree instead.
      </p>
    );
  }

  return (
    <Combobox.Root
      value={selected}
      onValueChange={(ws: ProjectWorkspaceOption | null) => {
        if (ws?.workspaceId && !ws.disabledReason) onSelect(ws.workspaceId);
      }}
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
      isItemEqualToValue={(a: ProjectWorkspaceOption, b: ProjectWorkspaceOption) => a.key === b.key}
    >
      <Combobox.Trigger className={cn(FIELD_TRIGGER_CLASS, selected ? 'py-1.5' : 'h-8')}>
        {selected ? (
          <WorkspaceItemContent ws={selected} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-foreground-passive">
            Select a workspace…
          </span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 self-center text-foreground-passive" />
      </Combobox.Trigger>
      <Combobox.Content>
        <Combobox.Input
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="Search workspaces…"
          showTrigger={false}
        />
        <Combobox.List className="max-h-56">
          {filtered.map((ws) => (
            <Combobox.Item
              key={ws.key}
              value={ws}
              disabled={!!ws.disabledReason}
              showCheck={false}
              className="items-start py-1.5"
            >
              <WorkspaceItemContent ws={ws} />
            </Combobox.Item>
          ))}
          {filtered.length === 0 && <EmptyState label="No workspaces match" bare />}
        </Combobox.List>
      </Combobox.Content>
    </Combobox.Root>
  );
}
