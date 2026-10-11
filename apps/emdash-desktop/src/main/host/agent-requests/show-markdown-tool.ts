import {
  SHOW_MARKDOWN_INSTRUCTIONS,
  showMarkdownToolDefinition,
} from '@core/features/markdown-viewer/api/show-markdown-tool';
import { MarkdownAccess } from '@core/features/markdown-viewer/node/markdown-access';
import { createShowMarkdownHandler } from '@core/features/markdown-viewer/node/show-markdown-handler';
import { markdownShowHub } from '@core/features/markdown-viewer/node/show-markdown-hub';
import { getWorkspaceIdentityService } from '@main/bootstrap/core/service-instances';
import { textResult } from '@main/host/mcp/loopback-mcp-server';
import type { AgentSessionTool } from './agent-request-server';

/**
 * `show_markdown` on the session's `maestro` server: an agent hands the window a Markdown file
 * from its own workspace. The workspace comes from the token's scope, so the path is checked
 * against the caller's folders and no other agent's.
 */

const handle = createShowMarkdownHandler({
  // The identity service is created during boot, after this module loads.
  access: new MarkdownAccess({
    resolve: (workspaceId) => getWorkspaceIdentityService().resolve(workspaceId),
    resolveProject: (projectId) => getWorkspaceIdentityService().resolveProject(projectId),
  }),
  hub: markdownShowHub,
});

export const showMarkdownSessionTool: AgentSessionTool = {
  definition: {
    ...showMarkdownToolDefinition(),
    annotations: { title: 'Show a Markdown file', readOnlyHint: false, openWorldHint: false },
  },
  instructions: SHOW_MARKDOWN_INSTRUCTIONS,
  call: async (scope, args) => {
    const result = await handle(scope, args);
    return textResult(result.message, !result.ok);
  },
};
