import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { canvasViewDef } from '@core/features/canvas/contributions/views';
import {
  asProvisioned,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { openTaskTabBeside } from '@core/features/workbench/api/browser/task-composition-selectors';
import { log } from '@core/primitives/logging/browser/logger';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import type { MarkdownDoc } from '../contract';
import { isMarkdownPath } from '../markdown-paths';
import { placeMarkdown, type MarkdownPlacement, type ViewOnScreen } from '../placement';
import { getMarkdownViewerClient } from './client';
import type { MarkdownLinkOpener } from './markdown-link-seam';

/** The task-view tab kind that shows a Markdown file. */
export const MARKDOWN_TAB_KIND = 'markdown';

/**
 * How long opening a tab may take before it is reported as not opened. Shorter than the wait of
 * an agent's tool call, so the agent hears the truth. A task view that was not on screen has to
 * be restored first.
 */
const TASK_TAB_TIMEOUT_MS = 6_000;

export type MarkdownOpenOptions = {
  /** The conversation whose agent the file came from; a canvas window opens beside it. */
  readonly conversationId?: string;
};

export type MarkdownOpenResult = {
  readonly placement: MarkdownPlacement;
  /** False when no window showing the file came up. */
  readonly opened: boolean;
};

function viewOnScreen(): ViewOnScreen {
  const ref = getNavigation().currentRef;
  if (ref.viewId === canvasViewDef.id) return { kind: 'canvas' };
  const { projectId, taskId } = ref.params as { projectId?: string; taskId?: string };
  return ref.viewId === taskViewDef.id && projectId && taskId
    ? { kind: 'task', projectId, taskId }
    : { kind: 'other' };
}

/**
 * Opens a checked Markdown file in the window that fits the view on screen (see
 * `placeMarkdown`), and says where it went and whether it is showing. The same file opens once:
 * a second call brings its window forward.
 */
export async function openMarkdownDoc(
  doc: MarkdownDoc,
  options: MarkdownOpenOptions = {}
): Promise<MarkdownOpenResult> {
  const placement = placeMarkdown(viewOnScreen(), doc);
  if (placement.surface === 'canvas') {
    const canvas = getCanvasStore();
    const tileId = canvas.openDoc({
      ...doc,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });
    if (tileId) return { placement, opened: canvas.isDocOnScreen(tileId) };
    // The file's task has no place on the canvas (an automation run): its own view takes it.
    return openInTaskView(
      { surface: 'task', projectId: doc.projectId, taskId: doc.taskId, navigate: true },
      doc
    );
  }
  return openInTaskView(placement, doc);
}

async function openInTaskView(
  placement: Extract<MarkdownPlacement, { surface: 'task' }>,
  doc: MarkdownDoc
): Promise<MarkdownOpenResult> {
  if (placement.navigate) {
    getNavigation().navigate(
      taskViewDef({ projectId: placement.projectId, taskId: placement.taskId })
    );
  }
  const opening = openTaskTabBeside(placement.projectId, placement.taskId, MARKDOWN_TAB_KIND, {
    ...doc,
  }).catch((error: unknown) => {
    log.warn('markdown viewer: opening a tab failed', { error });
    return false;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), TASK_TAB_TIMEOUT_MS);
  });
  const opened = await Promise.race([opening, timedOut]);
  clearTimeout(timer);
  return { placement, opened };
}

/**
 * Opens the Markdown file a path names, after the main process has checked it against the
 * workspace's folders. A relative path is read against the workspace folder, or against the
 * folder of `from` when a document references it. False when the viewer may not show the file
 * (not Markdown, outside those folders, missing) or no window came up, so the caller can do what
 * it did before.
 */
export async function openMarkdownPath(
  workspace: Pick<MarkdownDoc, 'projectId' | 'workspaceId' | 'taskId'>,
  path: string,
  options: MarkdownOpenOptions & { readonly from?: string } = {}
): Promise<boolean> {
  if (!isMarkdownPath(path)) return false;
  try {
    const client = await getMarkdownViewerClient();
    const resolved = await client.resolve({
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      path,
      ...(options.from ? { from: options.from } : {}),
    });
    if (!resolved.success) return false;
    const result = await openMarkdownDoc(
      {
        projectId: workspace.projectId,
        workspaceId: workspace.workspaceId,
        taskId: workspace.taskId,
        path: resolved.data.path,
        title: resolved.data.name,
      },
      options
    );
    return result.opened;
  } catch (error: unknown) {
    log.warn('markdown viewer: opening a linked file failed', { error });
    return false;
  }
}

/** `openMarkdownPath` for a path in an agent's terminal or chat: the task names the workspace. */
export const openAgentMarkdownLink: MarkdownLinkOpener = async (source, path) => {
  if (!isMarkdownPath(path)) return false;
  const provisioned = asProvisioned(getTaskStore(source.projectId, source.taskId));
  if (!provisioned) return false;
  return openMarkdownPath(
    { projectId: source.projectId, workspaceId: provisioned.workspaceId, taskId: source.taskId },
    path,
    source.conversationId ? { conversationId: source.conversationId } : {}
  );
};
