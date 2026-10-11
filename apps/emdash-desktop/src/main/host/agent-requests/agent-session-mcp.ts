import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { agentRequestHub } from '@core/features/conductor/node/agent-request-hub';
import type { TuiSessionMcp } from '@core/features/conversations/node/tui-conversation-provider';
import {
  BROWSER_CONTROL_TOKEN_ENV,
  resolveBrowserControlMcpServers,
} from '@main/host/browser/browser-control-instance';
import { reserveLoopbackPort } from '@main/host/browser/reserved-ports';
import { log } from '@main/lib/logger';
import { AgentRequestServer } from './agent-request-server';
import { showMarkdownSessionTool } from './show-markdown-tool';

/**
 * The loopback MCP servers Maestro hands to a local agent session: the canvas browser tools when
 * agent control is on, and the conductor's request tool. ACP sessions take the registrations as
 * they are; terminal agents get them through a private config file and token env vars.
 */

export const agentRequestServer = new AgentRequestServer(
  (from, args) => agentRequestHub.submit(from, args),
  log,
  (port) => reserveLoopbackPort(port),
  [showMarkdownSessionTool]
);

/** Env var that carries a terminal agent's conductor token; argv and config never need it inline. */
export const AGENT_REQUEST_TOKEN_ENV = 'MAESTRO_CONDUCTOR_MCP_TOKEN';

type AgentSessionContext = Parameters<typeof resolveBrowserControlMcpServers>[0];

type SessionMcpServer = { name: string; url: string; headers?: Record<string, string> };

/** A session's server with the env var a terminal agent reads its token from. */
type ResolvedServer = { server: SessionMcpServer; tokenEnvVar: string };

/**
 * Browser tools first (only while agent control is on), then the conductor. The conductor server
 * does not depend on the canvas browser settings: the window's conductor refuses requests when
 * its own setting is off. One server failing to register does not cost the session the other.
 */
async function resolveServers(context: AgentSessionContext): Promise<ResolvedServer[]> {
  const [browser, conductor] = await Promise.all([
    resolveBrowserControlMcpServers(context).catch((error: unknown) => {
      log.warn('Agent session MCP: browser tools unavailable', { error: String(error) });
      return [];
    }),
    agentRequestServer
      .register({
        conversationId: context.conversationId,
        projectId: context.projectId,
        taskId: context.taskId,
        workspaceId: context.workspaceId,
        name: context.title,
      })
      .catch((error: unknown) => {
        log.warn('Agent session MCP: conductor requests unavailable', { error: String(error) });
        return null;
      }),
  ]);
  return [
    ...browser.map((server) => ({ server, tokenEnvVar: BROWSER_CONTROL_TOKEN_ENV })),
    ...(conductor ? [{ server: conductor, tokenEnvVar: AGENT_REQUEST_TOKEN_ENV }] : []),
  ];
}

/** Session MCP servers for a local ACP conversation. Each token is scoped to its conversation. */
export async function resolveAgentSessionMcpServers(
  context: AgentSessionContext
): Promise<SessionMcpServer[]> {
  return (await resolveServers(context)).map(({ server }) => server);
}

/**
 * The same servers for a local terminal (TUI) agent: the provider CLI gets them through its own
 * per-session flags (see the plugin's `mcp.sessionArgs`). CLIs that only read servers from a file
 * get `configPath`, a private MCP JSON file under userData; each token is also handed over in the
 * env var its server names. Returns undefined when no server could be registered.
 */
export async function resolveAgentSessionMcp(
  context: AgentSessionContext
): Promise<TuiSessionMcp | undefined> {
  const resolved = await resolveServers(context);
  const dir = await agentMcpDir();
  const configPath = join(dir, `${fileSafe(context.conversationId)}.json`);
  if (resolved.length === 0) {
    await rm(configPath, { force: true });
    return undefined;
  }
  const config = {
    mcpServers: Object.fromEntries(
      resolved.map(({ server }) => [
        server.name,
        { type: 'http', url: server.url, headers: server.headers },
      ])
    ),
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  return {
    sessionMcp: {
      configPath,
      servers: resolved.map(({ server, tokenEnvVar }) => ({
        name: server.name,
        url: server.url,
        tokenEnvVar,
      })),
    },
    env: Object.fromEntries(
      resolved.map(({ server, tokenEnvVar }) => [
        tokenEnvVar,
        server.headers?.Authorization?.replace(/^Bearer /, '') ?? '',
      ])
    ),
  };
}

let agentMcpDirReady: Promise<string> | undefined;

/** Tokens live only for this run, so files from earlier runs are stale: clear them once. */
function agentMcpDir(): Promise<string> {
  agentMcpDirReady ??= (async () => {
    const dir = join(app.getPath('userData'), 'chorus', 'agent-mcp');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  })();
  return agentMcpDirReady;
}

function fileSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}
