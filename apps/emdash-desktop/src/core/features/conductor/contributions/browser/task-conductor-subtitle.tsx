import { computed, type IComputedValue } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { cn } from '@core/primitives/styling/browser/cn';
import { taskSubtitle, type TaskSubtitleChat } from '../../api/task-subtitle';
import { getChatConductorManager } from './app-stores';

/**
 * The second line of a task's sidebar row: what the task's conductor or its chats last said, or
 * the branch it is on. Renders nothing when there is nothing to say, so the row's title centres.
 *
 * Live, and per row: the row observes only a computed of its own subtitle string, so it
 * re-renders when that string changes, not on every agent change elsewhere. The canvas's agent
 * entries are grouped by task once per change (`chatsByTask`), not filtered and sorted per row.
 */
export const TaskConductorSubtitle = observer(function TaskConductorSubtitle({
  taskId,
  branchName,
  className,
}: {
  taskId: string;
  branchName: string | null;
  className?: string;
}) {
  const subtitle = useMemo(
    () =>
      computed(() =>
        taskSubtitle({
          status: getChatConductorManager().peek(taskId)?.status ?? null,
          chats: chatsByTask().get(taskId) ?? [],
          branchName,
        })
      ),
    [taskId, branchName]
  );
  const text = subtitle.get();
  if (!text) return null;
  return (
    <span
      className={cn('block min-w-0 truncate text-xs text-foreground-muted', className)}
      title={text}
    >
      {text}
    </span>
  );
});

type CanvasStore = ReturnType<typeof getCanvasStore>;

/** One grouping per canvas store, rebuilt only when its agent entries change. */
const groupings = new WeakMap<
  CanvasStore,
  IComputedValue<ReadonlyMap<string, readonly TaskSubtitleChat[]>>
>();

/** Every task's chats, newest first, from one pass over the canvas's agent entries. */
function chatsByTask(): ReadonlyMap<string, readonly TaskSubtitleChat[]> {
  const canvas = getCanvasStore();
  let grouping = groupings.get(canvas);
  if (!grouping) {
    grouping = computed(() => groupChats(canvas.agentEntries));
    groupings.set(canvas, grouping);
  }
  return grouping.get();
}

function groupChats(
  entries: readonly AgentTileEntry[]
): ReadonlyMap<string, readonly TaskSubtitleChat[]> {
  const byTask = new Map<string, AgentTileEntry[]>();
  for (const entry of entries) {
    const list = byTask.get(entry.taskId);
    if (list) list.push(entry);
    else byTask.set(entry.taskId, [entry]);
  }
  const chats = new Map<string, readonly TaskSubtitleChat[]>();
  for (const [taskId, list] of byTask) {
    chats.set(taskId, list.sort((a, b) => lastTouched(b) - lastTouched(a)).map(subtitleChat));
  }
  return chats;
}

function subtitleChat(entry: AgentTileEntry): TaskSubtitleChat {
  return {
    status: entry.status,
    completionSummary: entry.completionSummary,
    decisionHeadline: entry.conductor?.headline ?? null,
    helpers: entry.subAgents?.length || entry.backgroundAgents || 0,
    helperLabel: entry.subAgents?.[0]?.label ?? null,
  };
}

/** When the developer last sent the chat something, else when its task was made. */
function lastTouched(entry: AgentTileEntry): number {
  const at = Date.parse(entry.lastInteractedAt ?? entry.createdAt ?? '');
  return Number.isNaN(at) ? 0 : at;
}
