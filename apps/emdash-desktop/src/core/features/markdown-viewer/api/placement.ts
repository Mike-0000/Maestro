/**
 * Where the Markdown viewer opens, given the view on screen. Pure, so the rule can be tested
 * without the window. Each answer is a window in a system the app already has: a canvas window
 * (which joins the sub-canvas or desk in view like any new window), or a tab in a task view's
 * pane to the right.
 */

export type ViewOnScreen =
  | { readonly kind: 'canvas' }
  | { readonly kind: 'task'; readonly projectId: string; readonly taskId: string }
  /** Home, settings and the other views that hold no agent windows. */
  | { readonly kind: 'other' };

export type MarkdownPlacement =
  | { readonly surface: 'canvas' }
  | {
      readonly surface: 'task';
      readonly projectId: string;
      readonly taskId: string;
      /** The task view is not on screen and has to be opened first. */
      readonly navigate: boolean;
    };

export function placeMarkdown(
  view: ViewOnScreen,
  source: { readonly projectId: string; readonly taskId: string }
): MarkdownPlacement {
  if (view.kind === 'canvas') return { surface: 'canvas' };
  // The developer is looking at a task: the file opens beside it, whichever agent sent it.
  if (view.kind === 'task') {
    return { surface: 'task', projectId: view.projectId, taskId: view.taskId, navigate: false };
  }
  // A view without agent windows: the file opens in its own agent's task view.
  return { surface: 'task', projectId: source.projectId, taskId: source.taskId, navigate: true };
}

/** What the agent is told once its file is on screen. */
export function placementMessage(title: string, placement: MarkdownPlacement): string {
  return placement.surface === 'canvas'
    ? `Opened ${title} for the developer in a window on the canvas.`
    : `Opened ${title} for the developer in a pane beside the agent.`;
}
