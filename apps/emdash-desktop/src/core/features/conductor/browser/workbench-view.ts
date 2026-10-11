import { canvasViewDef } from '@core/features/canvas/contributions/views';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import type { WorkbenchView } from '../api/focus';

type Pane = NonNullable<ReturnType<typeof getTaskComposition>>['activePane'];

/** The conversation a pane shows when its active tab is a chat (terminal or ACP), else null. */
function activeChat(pane: Pane): string | null {
  const entry = pane.activeEntry;
  if (entry?.kind !== 'conversation' && entry?.kind !== 'acp-chat') return null;
  return (entry.state as { conversationId?: string }).conversationId ?? null;
}

/**
 * What the workbench shows right now, for the conductor's focus: the canvas, a task's view with
 * the chat in front, or another view. Read on every turn, so a change of view or tab is in the
 * next context.
 */
export function readWorkbenchView(): WorkbenchView {
  const ref = getNavigation().currentRef;
  if (ref.viewId === canvasViewDef.id) return { kind: 'canvas' };
  const params = ref.params as { projectId?: string; taskId?: string };
  if (ref.viewId !== taskViewDef.id || !params.projectId || !params.taskId) {
    return {
      kind: 'other',
      viewId: ref.viewId,
      ...(params.projectId ? { projectId: params.projectId } : {}),
    };
  }
  const layout = getTaskComposition(params.projectId, params.taskId)?.paneLayout;
  return {
    kind: 'task',
    projectId: params.projectId,
    taskId: params.taskId,
    activeChatId: layout ? activeChat(layout.focusedPane) : null,
    visibleChatIds: layout ? layout.groups.flatMap((group) => activeChat(group.pane) ?? []) : [],
  };
}
