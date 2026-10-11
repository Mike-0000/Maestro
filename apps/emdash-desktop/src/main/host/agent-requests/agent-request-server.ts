import type { Logger } from '@emdash/shared/logger';
import {
  AGENT_REQUEST_INSTRUCTIONS,
  AGENT_REQUEST_MCP_NAME,
  AGENT_REQUEST_TOOL_NAME,
  agentRequestToolDefinition,
  type AgentRequest,
  type AgentRequestAck,
} from '@core/features/conductor/api/agent-requests';
import {
  LoopbackMcpServer,
  textResult,
  type LoopbackMcpTool,
  type ToolResult,
} from '@main/host/mcp/loopback-mcp-server';

/**
 * Loopback MCP server through which a coding agent sends requests to the conductor. It has one
 * tool; the kinds of request and what each may do are defined with the request itself, in
 * `@core/features/conductor/api/agent-requests`.
 *
 * The sender of a request is the scope of the bearer token it arrived with. Nothing in the tool
 * arguments can name another conversation, task or project, so an agent can only ask as itself.
 */

export const AGENT_REQUEST_TOKEN_PREFIX = 'maestro_at_';

export type AgentRequestScope = {
  conversationId: string;
  projectId: string;
  taskId: string;
  /** The agent's working directory. Tools that read its files check paths against it. */
  workspaceId?: string;
  name: string;
};

/**
 * A tool that shares this server and its tokens with `conductor_request`. Like it, the tool acts
 * for the scope of the token it was called with.
 */
export type AgentSessionTool = {
  readonly definition: LoopbackMcpTool;
  /** Appended to the server's instructions. */
  readonly instructions?: string;
  readonly call: (scope: AgentRequestScope, args: Record<string, unknown>) => Promise<ToolResult>;
};

/** Hands a request to the conductor and resolves with its verdict. */
export type AgentRequestSubmit = (
  from: AgentRequest['from'],
  args: Record<string, unknown>
) => Promise<AgentRequestAck>;

const TOOLS = [
  {
    ...agentRequestToolDefinition(),
    annotations: { title: 'Ask the conductor', readOnlyHint: false, openWorldHint: false },
  },
] as const;

export class AgentRequestServer extends LoopbackMcpServer<AgentRequestScope> {
  constructor(
    private readonly submit: AgentRequestSubmit,
    logger: Logger,
    onPort?: (port: number) => void,
    private readonly sessionTools: readonly AgentSessionTool[] = []
  ) {
    super(
      {
        name: AGENT_REQUEST_MCP_NAME,
        tokenPrefix: AGENT_REQUEST_TOKEN_PREFIX,
        instructions: [
          AGENT_REQUEST_INSTRUCTIONS,
          ...sessionTools.flatMap((tool) => tool.instructions ?? []),
        ].join(' '),
        tools: [...TOOLS, ...sessionTools.map((tool) => tool.definition)],
        logLabel: 'AgentRequestServer',
        sameScope,
        ...(onPort ? { onPort } : {}),
      },
      logger
    );
  }

  async callTool(
    scope: AgentRequestScope,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const sessionTool = this.sessionTools.find((tool) => tool.definition.name === name);
    if (sessionTool) return sessionTool.call(scope, args);
    if (name !== AGENT_REQUEST_TOOL_NAME) return textResult(`Unknown tool ${name}.`, true);
    const ack = await this.submit(
      { conversationId: scope.conversationId, taskId: scope.taskId, projectId: scope.projectId },
      args
    );
    return textResult(ack.message, !ack.accepted);
  }
}

function sameScope(left: AgentRequestScope, right: AgentRequestScope): boolean {
  return left.projectId === right.projectId && left.taskId === right.taskId;
}
