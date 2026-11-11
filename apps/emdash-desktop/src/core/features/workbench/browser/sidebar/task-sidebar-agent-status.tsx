import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { RelativeTime } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { sidebarTaskStatus } from '@core/features/conductor/contributions/browser/task-ownership';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import { useDelayedBoolean } from '@core/primitives/react-hooks/browser/use-delay-boolean';
import { getSortInstant, sortKindFor } from './sidebar-store';

/**
 * Sidebar trailing slot: the setting-up mark while bootstrapping, the task's state glyph while
 * an agent is active or unread, otherwise the relative timestamp. The whole metadata cluster is
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
        <StateGlyph state="setting-up" label="Creating workspace…" />
      </Slot>
    );
  }

  // The state glyph while the task is yours or at work (the ownership line's rule: a waiting
  // agent stays marked after it is seen); the timestamp once the task is quiet.
  const status = sidebarTaskStatus(task.data.id);
  if (status !== null && status !== 'idle') {
    return (
      <Slot>
        <StateGlyph state={GLYPH_FOR_STATUS[status]} label data-status={status} />
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

/**
 * The kit's one set of state marks (the conductor screen draws the same): a filled near-white
 * dot when the task waits on the developer, a softly pulsing accent dot while it works, a bright
 * ring for a finish not looked at yet, and the error dot. Each announces its words and shows
 * them in a tooltip.
 */
const GLYPH_FOR_STATUS: Record<Exclude<AgentStatus, 'idle'>, StateGlyphState> = {
  'awaiting-input': 'needs-you',
  working: 'working',
  completed: 'unread',
  error: 'error',
};
