import { browserSessionStore } from '@core/features/browser/api/browser/browser-session-store';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { getCanvasBrowserHost } from '@core/features/canvas/contributions/browser/app-stores';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { TaskBrowser, TaskBrowserPort } from './session';

/** The browser tab kind of the task view (see the browser slice's tab provider). */
const BROWSER_TAB = 'browser';

type BrowserTab = { browserId: string; tabId: string; paneId: string };

/**
 * A task's browser tabs in its task view, for its conductor: the same tabs the developer opens
 * from the task, in the developer's own browser profile. Where a URL may go is decided before any
 * of this is called (see `decideBrowserUrl`).
 */
export function createTaskBrowserPort(canvas: CanvasStore, taskId: string): TaskBrowserPort {
  const identity = () => {
    const entry = canvas.agentEntries.find((candidate) => candidate.taskId === taskId);
    return entry ? { projectId: entry.projectId, workspaceId: entry.workspaceId, taskId } : null;
  };
  /** The task with its workspace, for its dev servers; null while it has none. */
  const workspace = () => {
    const task = identity();
    return task?.workspaceId ? { projectId: task.projectId, workspaceId: task.workspaceId } : null;
  };
  const layout = () => {
    const task = identity();
    return task ? getTaskComposition(task.projectId, taskId)?.paneLayout : undefined;
  };
  const tabs = (): BrowserTab[] => {
    const panes = layout()?.groups ?? [];
    return panes.flatMap((group) =>
      [...group.pane.entries.values()].flatMap((entry) => {
        if (entry.kind !== BROWSER_TAB) return [];
        const browserId = (entry.state as { browserId?: unknown }).browserId;
        return typeof browserId === 'string'
          ? [{ browserId, tabId: entry.tabId, paneId: group.paneId }]
          : [];
      })
    );
  };
  const describe = (browserId: string): TaskBrowser => {
    const session = browserSessionStore.getSession(browserId);
    return {
      id: browserId,
      url: session?.currentUrl ?? 'about:blank',
      title: session?.title ?? null,
    };
  };

  return {
    list: () => tabs().map((tab) => describe(tab.browserId)),

    open(url) {
      const panes = layout();
      if (!panes) {
        throw new Error(
          "This task's view is not open, so there is nowhere to show a browser. The developer opens the task first."
        );
      }
      const before = new Set(tabs().map((tab) => tab.browserId));
      const focused = panes.activePaneId;
      // Beside what the developer is looking at, without taking the keyboard from them.
      panes.open(BROWSER_TAB, url ? { initialUrl: url } : {}, { target: 'right', preview: false });
      panes.setActiveGroup(focused);
      const opened = tabs().find((tab) => !before.has(tab.browserId));
      if (!opened) throw new Error('The browser tab did not open.');
      return describe(opened.browserId);
    },

    navigate(id, url) {
      if (!tabs().some((tab) => tab.browserId === id)) {
        throw new Error(`No browser tab of this task has the id ${id}.`);
      }
      browserSessionStore.requestNavigation(id, url);
    },

    close(id) {
      const tab = tabs().find((candidate) => candidate.browserId === id);
      if (!tab) throw new Error(`No browser tab of this task has the id ${id}.`);
      layout()
        ?.groups.find((group) => group.paneId === tab.paneId)
        ?.pane.closeTab(tab.tabId);
    },

    devServerOrigins() {
      const task = workspace();
      if (!task) return [];
      return getCanvasBrowserHost()
        .devServerUrls(task)
        .flatMap((url) => {
          try {
            return [new URL(url).origin];
          } catch {
            return [];
          }
        });
    },

    publicWebEnabled: () => getCanvasBrowserHost().conductorPublicWebEnabled(),
  };
}
