import {
  getTaskComposition,
  openTaskTabBeside,
} from '@core/features/workbench/api/browser/task-composition-selectors';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  isIsolatedBrowserPartition,
} from '@core/primitives/browser/api';
import { browserSessionStore } from './browser-session-store';
import { taskBrowserControl, type TaskBrowserControl } from './task-browser-control';

/** The browser tab kind of the task view (see the browser slice's tab provider). */
const BROWSER_TAB = 'browser';

export type TaskViewBrowserTabInfo = {
  browserId: string;
  isolated: boolean;
  control: TaskBrowserControl;
  /** The tab in front of its pane. */
  inFront: boolean;
};

/** The browser tabs open in a task's view; empty while the view has no pane layout. */
export function listTaskViewBrowserTabs(
  projectId: string,
  taskId: string
): TaskViewBrowserTabInfo[] {
  const layout = getTaskComposition(projectId, taskId)?.paneLayout;
  if (!layout) return [];
  return layout.groups.flatMap((group) =>
    [...group.pane.entries.values()].flatMap((entry) => {
      if (entry.kind !== BROWSER_TAB) return [];
      const browserId = (entry.state as { browserId?: unknown }).browserId;
      if (typeof browserId !== 'string') return [];
      const session = browserSessionStore.getSession(browserId);
      if (!session) return [];
      return [
        {
          browserId,
          isolated: isIsolatedBrowserPartition(session.partition),
          control: taskBrowserControl.control(browserId),
          inFront: group.pane.activeEntry?.tabId === entry.tabId,
        },
      ];
    })
  );
}

/**
 * Opens a browser tab beside what the developer is looking at in a task's view, on the task's
 * isolated profile and driven by agents, and registers it with main. Its id, or null when the
 * task has no view to open it in or main refused it.
 */
export async function openAgentTaskViewBrowserTab(
  projectId: string,
  taskId: string,
  initialUrl: string | undefined
): Promise<string | null> {
  const browserId = crypto.randomUUID();
  const opened = await openTaskTabBeside(projectId, taskId, BROWSER_TAB, {
    browserId,
    profileId: BROWSER_ISOLATED_PROFILE_ID,
    control: 'agents',
    ...(initialUrl ? { initialUrl } : {}),
  });
  if (!opened || !browserSessionStore.getSession(browserId)) return null;
  return (await taskBrowserControl.sync(browserId)) ? browserId : null;
}
