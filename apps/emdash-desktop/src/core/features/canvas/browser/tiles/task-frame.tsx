import type { NodeProps } from '@xyflow/react';
import { FileDiff, GitBranch, PanelsTopLeft } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { cn } from '@core/primitives/styling/browser/cn';
import { FRAME_HEADER } from '../../api/canvas-model';
import { getCanvasStore } from '../../contributions/browser/app-stores';

export type TaskFrameData = { frameId: string };

/** How long to wait for the task view to mount before opening its Changes panel. */
const REVIEW_OPEN_TIMEOUT_MS = 4_000;

/** Opens the task view and its Changes sidebar (the existing diff review). */
export async function openTaskDiffReview(projectId: string, taskId: string): Promise<void> {
  getNavigation().navigate(taskViewDef({ projectId, taskId }));
  const deadline = Date.now() + REVIEW_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const composition = getTaskComposition(projectId, taskId);
    if (composition) {
      composition.chrome.commands.openSidebarTab('changes');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * A frame around one task's agents: its worktree, diff size, and a jump into diff review. Drag the
 * header to move the whole task; the frame itself never captures clicks on the tiles inside it.
 */
export const TaskFrameNode = observer(function TaskFrameNode({ data }: NodeProps) {
  const { frameId } = data as TaskFrameData;
  const frame = getCanvasStore().taskFrames.find((candidate) => candidate.frameId === frameId);
  if (!frame) return null;
  const changed = frame.linesAdded > 0 || frame.linesDeleted > 0;

  return (
    <div className="pointer-events-none h-full w-full rounded-2xl border border-dashed border-foreground/15 bg-foreground/[0.02]">
      <div
        className="chorus-frame-handle pointer-events-auto flex cursor-grab items-center gap-2 px-3 text-xs text-foreground-muted active:cursor-grabbing"
        style={{ height: FRAME_HEADER }}
        title="Drag to move this task's agents"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">{frame.taskName}</span>
        <span className="truncate">· {frame.projectName}</span>
        {frame.waiting > 0 && (
          <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
            {frame.waiting} waiting
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void openTaskDiffReview(frame.projectId, frame.taskId)}
          title="Review this task's changes"
          className={cn(
            'nodrag flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background-secondary hover:text-foreground',
            !changed && 'opacity-60'
          )}
        >
          <FileDiff className="size-3.5" />
          {changed ? (
            <span className="font-mono tabular-nums">
              <span className="text-green-600 dark:text-green-400">+{frame.linesAdded}</span>{' '}
              <span className="text-red-600 dark:text-red-400">−{frame.linesDeleted}</span>
            </span>
          ) : (
            'No changes'
          )}
        </button>
        <button
          type="button"
          aria-label="Open in task view"
          title="Open in task view"
          onClick={() =>
            getNavigation().navigate(
              taskViewDef({ projectId: frame.projectId, taskId: frame.taskId })
            )
          }
          className="nodrag flex size-5 shrink-0 items-center justify-center rounded hover:bg-background-secondary hover:text-foreground"
        >
          <PanelsTopLeft className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
