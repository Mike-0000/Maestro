import { BrailleSpinner } from '@emdash/ui/react/components';
import { RelativeTime, Tooltip } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { sidebarTaskStatus } from '@core/features/conductor/contributions/browser/task-ownership';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import { useDelayedBoolean } from '@core/primitives/react-hooks/browser/use-delay-boolean';
import { cn } from '@core/primitives/styling/browser/cn';
import { getSortInstant, sortKindFor } from './sidebar-store';

/**
 * Sidebar trailing slot: spinner while bootstrapping, the task's state glyph while an agent is
 * active or unread, otherwise the relative timestamp. The whole metadata cluster is
 * right-aligned by the parent, so the slot just hugs its content.
 */
function Slot({ children }: { children: React.ReactNode }) {
  return <span className="flex h-4 w-[3ch] shrink-0 items-center justify-end">{children}</span>;
}

export const TaskSidebarTrailingSlot = observer(function TaskSidebarTrailingSlot({
  task,
  showTimestamp,
}: {
  task: TaskStore;
  showTimestamp: boolean;
}) {
  const delayedIsBootstrapping = useDelayedBoolean(task.isBootstrapping, 500);

  if (delayedIsBootstrapping) {
    return (
      <Slot>
        <Tooltip.Root>
          <Tooltip.Trigger>
            <span className="flex size-4 items-center justify-center text-foreground-passive">
              <BrailleSpinner variant="wave" />
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content>Creating workspace...</Tooltip.Content>
        </Tooltip.Root>
      </Slot>
    );
  }

  // The state glyph while the task is yours or at work (the ownership line's rule: a waiting
  // agent stays marked after it is seen); the timestamp once the task is quiet.
  const status = sidebarTaskStatus(task.data.id);
  if (status !== null && status !== 'idle') {
    return (
      <Slot>
        <TaskStateGlyph status={status} />
      </Slot>
    );
  }

  if (!showTimestamp) return null;

  const instant = getSortInstant(task, sortKindFor(getSidebarStore().taskSortBy));
  if (!instant) return null;

  return (
    <Slot>
      <RelativeTime
        value={instant}
        className="font-sans text-tiny leading-4 text-foreground-passive tabular-nums"
        compact
      />
    </Slot>
  );
});

type ActiveStatus = Exclude<AgentStatus, 'idle'>;

const STATUS_LABELS: Record<ActiveStatus, string> = {
  'awaiting-input': 'Needs you',
  working: 'Working',
  completed: 'Finished, not looked at yet',
  error: 'Stopped on an error',
};

/**
 * One small mark per state, the same set the conductor screen uses: a filled near-white dot when
 * the task waits on the developer, a softly pulsing accent dot while it works, a ring when it
 * finished (bright, because an unread finish is the developer's to look at), and a filled red dot
 * on an error. The pulse stops under reduced motion.
 */
function TaskStateGlyph({ status }: { status: ActiveStatus }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            role="img"
            aria-label={STATUS_LABELS[status]}
            data-status={status}
            className="flex size-4 items-center justify-center"
          >
            <span
              aria-hidden
              className={cn(
                'rounded-full',
                status === 'working' && 'size-1.5 bg-accent motion-safe:animate-pulse',
                status === 'awaiting-input' && 'size-2 bg-foreground',
                status === 'completed' && 'size-2 border-[1.5px] border-foreground',
                status === 'error' && 'size-2 bg-foreground-error'
              )}
            />
          </span>
        }
      />
      <Tooltip.Content>{STATUS_LABELS[status]}</Tooltip.Content>
    </Tooltip.Root>
  );
}
