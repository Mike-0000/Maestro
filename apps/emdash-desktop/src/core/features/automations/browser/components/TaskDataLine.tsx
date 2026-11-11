import { StateGlyph } from '@emdash/ui/react/components';
import { observer } from 'mobx-react-lite';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import type { AgentStatus } from '@core/primitives/agents/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { agentRunState } from './agent-state';

export interface TaskDataLineProps {
  task: TaskStore;
  agentStatus: AgentStatus | null;
  missedDeadline: boolean;
}

/** A run's first line once it has a task: the task's name, its agent's state mark, its diff. */
export const TaskDataLine = observer(function TaskDataLine({
  task,
  agentStatus,
  missedDeadline,
}: TaskDataLineProps) {
  const state = agentRunState(agentStatus);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'min-w-0 truncate text-sm',
          missedDeadline ? 'text-foreground-muted' : 'text-foreground'
        )}
      >
        {task.displayName}
      </span>
      {state ? <StateGlyph state={state.glyph} label={state.words} /> : null}
      <span className="flex-1" />
      <TaskGitDiffStats task={task} className="shrink-0 text-xs tabular-nums" />
    </div>
  );
});
