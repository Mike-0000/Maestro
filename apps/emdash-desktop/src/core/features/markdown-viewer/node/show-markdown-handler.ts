import { fileNameOf } from '../api/markdown-paths';
import { parseShowMarkdownArguments } from '../api/show-markdown-tool';
import type { MarkdownAccess } from './markdown-access';
import type { MarkdownShowHub } from './show-markdown-hub';

/** The conversation a `show_markdown` call came from: the scope of its session token. */
export type ShowMarkdownCaller = {
  readonly conversationId: string;
  readonly projectId: string;
  readonly taskId: string;
  /** The agent's working directory. Absent for a session that has no workspace. */
  readonly workspaceId?: string;
};

export type ShowMarkdownResult = { readonly ok: boolean; readonly message: string };

export type ShowMarkdownHandler = (
  caller: ShowMarkdownCaller,
  args: Record<string, unknown>
) => Promise<ShowMarkdownResult>;

/**
 * Handles an agent's `show_markdown` call: checks the path against the caller's own workspace,
 * then hands the file to the window. The file is checked before the window hears of it, so a
 * refused path never reaches the renderer.
 */
export function createShowMarkdownHandler(deps: {
  access: Pick<MarkdownAccess, 'resolveDocument'>;
  hub: Pick<MarkdownShowHub, 'show'>;
}): ShowMarkdownHandler {
  return async (caller, args) => {
    const parsed = parseShowMarkdownArguments(args);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    if (!caller.workspaceId) {
      return { ok: false, message: 'This session has no workspace, so it has no files to show.' };
    }
    const resolved = await deps.access.resolveDocument({
      projectId: caller.projectId,
      workspaceId: caller.workspaceId,
      path: parsed.value.path,
    });
    if (!resolved.success) return { ok: false, message: resolved.error.message };
    const ack = await deps.hub.show({
      conversationId: caller.conversationId,
      doc: {
        projectId: caller.projectId,
        workspaceId: caller.workspaceId,
        taskId: caller.taskId,
        path: resolved.data.path,
        title: parsed.value.title ?? fileNameOf(resolved.data.path),
      },
      present: parsed.value.present,
    });
    return { ok: ack.outcome !== 'failed', message: ack.message };
  };
}
