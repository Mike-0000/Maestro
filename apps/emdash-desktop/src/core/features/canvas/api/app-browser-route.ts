import type { BrowserOpenAccess } from '@core/primitives/browser/api';

/** A browser tab in a task's own view, as an agent's open request sees it. */
export type TaskViewBrowserTab = {
  browserId: string;
  /** On the task's isolated profile (agents may use it); otherwise the developer's own profile. */
  isolated: boolean;
  control: 'user' | 'agents';
  /** The tab in front of its pane, so the developer can see it. */
  inFront: boolean;
};

export type AppBrowserRouteInput = {
  access: BrowserOpenAccess;
  /** The browser main wants (the task's browser the developer looked at last), if any. */
  requestedBrowserId: string | null;
  /** The task's canvas tile, if it has one. */
  canvasBrowserId: string | null;
  /** Browser tabs in the task's view (empty when the view is not open). */
  taskViewTabs: readonly TaskViewBrowserTab[];
  /** The developer is in this task's view right now. */
  taskViewOnScreen: boolean;
};

/**
 * Where an agent's open request is served:
 * - `canvas`: the task's canvas tile (opened, resumed, or handed over as before);
 * - `task-tab`: a browser tab in the task's own view. `handOver` asks the developer to give it to
 *   agents, and `isolate` says that means moving it off their own profile to the task's isolated
 *   one, since a tab with the developer's logins is never given to an agent as it is;
 * - `new-task-tab`: a new tab beside the chat, on the task's isolated profile;
 * - `none`: nothing to watch (observe only resumes what exists).
 */
export type AppBrowserRoute =
  | { kind: 'canvas' }
  | { kind: 'task-tab'; browserId: string; handOver: boolean; isolate: boolean }
  | { kind: 'new-task-tab' }
  | { kind: 'none' };

/**
 * Decides which browser serves an agent's open request, so agents end up in the browser the
 * developer is using for the task. Main names that browser when it knows one; otherwise the
 * developer's current place decides: their task view when they are in it, else the canvas.
 */
export function routeAppBrowserRequest(input: AppBrowserRouteInput): AppBrowserRoute {
  const canvasRequested =
    input.requestedBrowserId !== null && input.requestedBrowserId === input.canvasBrowserId;
  // The developer's place decides only when main named no browser it can still find here.
  const byPlace = input.taskViewOnScreen && !canvasRequested;
  const tab =
    input.taskViewTabs.find((candidate) => candidate.browserId === input.requestedBrowserId) ??
    (byPlace ? pickTab(input.taskViewTabs) : undefined);
  if (tab) {
    if (input.access === 'observe') {
      return { kind: 'task-tab', browserId: tab.browserId, handOver: false, isolate: false };
    }
    const ready = tab.isolated && tab.control === 'agents';
    return { kind: 'task-tab', browserId: tab.browserId, handOver: !ready, isolate: !tab.isolated };
  }
  if (input.access === 'observe') {
    return input.canvasBrowserId ? { kind: 'canvas' } : { kind: 'none' };
  }
  return byPlace ? { kind: 'new-task-tab' } : { kind: 'canvas' };
}

/** The tab the developer most likely uses: in front of its pane, then agent-ready, then first. */
function pickTab(tabs: readonly TaskViewBrowserTab[]): TaskViewBrowserTab | undefined {
  const score = (tab: TaskViewBrowserTab) =>
    (tab.inFront ? 4 : 0) + (tab.isolated ? 2 : 0) + (tab.control === 'agents' ? 1 : 0);
  let best: TaskViewBrowserTab | undefined;
  for (const tab of tabs) if (!best || score(tab) > score(best)) best = tab;
  return best;
}
