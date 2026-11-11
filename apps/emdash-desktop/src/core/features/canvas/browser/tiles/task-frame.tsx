import { StateGlyph } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import type { NodeProps } from '@xyflow/react';
import { AppWindow, FileDiff, GitBranch, PanelsTopLeft, Play, Square } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { TaskFrameEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { FRAME_HEADER } from '../../api/canvas-model';
import { getCanvasBrowserHost, getCanvasStore } from '../../contributions/browser/app-stores';
import { TileIconButton } from './tile-icon-button';

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
    <div className="pointer-events-none h-full w-full rounded-xl border border-dashed border-border bg-foreground/2">
      <div
        className="chorus-frame-handle pointer-events-auto flex cursor-grab items-center gap-2 px-2.5 text-xs text-foreground-passive active:cursor-grabbing"
        style={{ height: FRAME_HEADER }}
        title="Drag to move this task's agents"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate text-foreground-muted">{frame.taskName}</span>
        <span className="min-w-0 truncate">· {frame.projectName}</span>
        {frame.waiting > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-foreground">
            <StateGlyph state="needs-you" size="sm" />
            {frame.waiting} waiting
          </span>
        )}
        <span className="flex-1" />
        <AppControls frame={frame} />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void openTaskDiffReview(frame.projectId, frame.taskId)}
          title="Review this task's changes"
          className="nodrag shrink-0 gap-1 px-1.5"
        >
          <FileDiff className="size-3.5" />
          {changed ? (
            <span className="flex items-center gap-1 tabular-nums">
              <span className="text-foreground-diff-added">+{frame.linesAdded}</span>
              <span className="text-foreground-diff-deleted">−{frame.linesDeleted}</span>
            </span>
          ) : (
            'No changes'
          )}
        </Button>
        <TileIconButton
          label="Open in task view"
          onClick={() =>
            getNavigation().navigate(
              taskViewDef({ projectId: frame.projectId, taskId: frame.taskId })
            )
          }
        >
          <PanelsTopLeft className="size-3.5" />
        </TileIconButton>
      </div>
    </div>
  );
});

/** Run, show, and stop the task's app (its `run` script and dev server). */
const AppControls = observer(function AppControls({ frame }: { frame: TaskFrameEntry }) {
  const { value: settings } = useAppSettingsKey('canvasBrowser');
  const host = getCanvasBrowserHost();
  const canvas = getCanvasStore();
  const workspaceId = frame.workspaceId;
  if (!workspaceId || settings?.enabled === false) return null;
  const target = { projectId: frame.projectId, workspaceId, taskId: frame.taskId };
  const starting = host.starting.has(frame.taskId);
  const running = host.appRunning(target);
  const browser = canvas.browserForTask(frame.taskId);
  // shrink-0: a long task name truncates; the buttons never shrink under their labels.
  const buttonClass = 'nodrag shrink-0 gap-1 px-1.5';

  if (starting) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 px-1.5" role="status">
        <StateGlyph state="setting-up" size="sm" />
        Starting app…
      </span>
    );
  }
  if (!running) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={buttonClass}
        title="Run this task's app (its run script) and open it here"
        onClick={() => void host.runApp(target)}
      >
        <Play className="size-3.5" />
        Run app
      </Button>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={buttonClass}
        title={browser ? 'Show the app browser' : 'Open the running app on the canvas'}
        onClick={() => {
          if (browser) canvas.requestFocus(browser.tileId);
          host.openForTask(target);
        }}
      >
        <AppWindow className="size-3.5" />
        {browser ? 'Show app' : 'Open app'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon
        aria-label="Stop app"
        title="Stop the app's dev server"
        className="nodrag shrink-0"
        onClick={() => void host.stopApp(target)}
      >
        <Square className="size-3" />
      </Button>
    </>
  );
});
