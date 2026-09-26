import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TuiAgentStartInput } from '@emdash/core/runtimes/tui-agents/api';
import { app } from 'electron';
import { browserEvents } from '@core/features/browser/node';
import { previewServerService } from '@core/features/preview-servers/api/node/preview-server-service-instance';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import { log } from '@main/lib/logger';
import { BrowserAutomation } from './browser-automation';
import { BrowserConsoleBuffer } from './browser-console-buffer';
import { BROWSER_CONTROL_MCP_NAME, BrowserControlServer } from './browser-control-server';
import { BrowserControlService } from './browser-control-service';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { reserveLoopbackPort, reservedLoopbackPorts } from './reserved-ports';

export const browserAutomation = new BrowserAutomation();
export const browserConsoleBuffer = new BrowserConsoleBuffer();

export const browserControlService = new BrowserControlService({
  registry: browserWebContentsRegistry,
  automation: browserAutomation,
  consoleBuffer: browserConsoleBuffer,
  emit: (event) => browserEvents.emit(undefined, event),
  getSettings: () => getAppSettingsService().get('canvasBrowser'),
  listDevServerUrls: ({ projectId, workspaceId }) =>
    previewServerService
      .listForWorkspace({ projectId, workspaceId })
      .map((server) => previewServerUrl(server))
      .filter((url): url is string => url !== null),
  reservedPorts: reservedLoopbackPorts,
});

export const browserControlServer = new BrowserControlServer(browserControlService, log, (port) =>
  reserveLoopbackPort(port)
);

/**
 * Session MCP servers for a local ACP conversation: the browser control server when agent control
 * is on. The token is scoped to the conversation's task.
 */
export async function resolveBrowserControlMcpServers(context: {
  conversationId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  title: string;
}): Promise<Array<{ name: string; url: string; headers?: Record<string, string> }>> {
  const settings = await getAppSettingsService().get('canvasBrowser');
  if (!settings.enabled || !settings.agentControl) {
    browserControlServer.revoke(context.conversationId);
    return [];
  }
  return [
    await browserControlServer.register({
      kind: 'agent',
      conversationId: context.conversationId,
      name: context.title,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      taskId: context.taskId,
    }),
  ];
}

/** Env var that carries a terminal agent's browser token; argv and config never need it inline. */
export const BROWSER_CONTROL_TOKEN_ENV = 'CHORUS_BROWSER_MCP_TOKEN';

type AgentBrowserContext = Parameters<typeof resolveBrowserControlMcpServers>[0];

/**
 * The browser control server for a local terminal (TUI) agent: the provider CLI gets it through
 * its own per-session flags (see the plugin's `mcp.sessionArgs`). CLIs that only read servers
 * from a file get `configPath`, a private MCP JSON file under userData; the token is also handed
 * over in `BROWSER_CONTROL_TOKEN_ENV`. Returns undefined when agent control is off.
 */
export async function resolveBrowserControlSessionMcp(context: AgentBrowserContext): Promise<
  | {
      sessionMcp: NonNullable<TuiAgentStartInput['sessionMcp']>;
      env: Record<string, string>;
    }
  | undefined
> {
  const [server] = await resolveBrowserControlMcpServers(context);
  const dir = await agentMcpDir();
  const configPath = join(dir, `${fileSafe(context.conversationId)}.json`);
  if (!server) {
    await rm(configPath, { force: true });
    return undefined;
  }
  const token = server.headers?.Authorization?.replace(/^Bearer /, '') ?? '';
  const config = {
    mcpServers: {
      [BROWSER_CONTROL_MCP_NAME]: { type: 'http', url: server.url, headers: server.headers },
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  return {
    sessionMcp: {
      configPath,
      servers: [
        { name: BROWSER_CONTROL_MCP_NAME, url: server.url, tokenEnvVar: BROWSER_CONTROL_TOKEN_ENV },
      ],
    },
    env: { [BROWSER_CONTROL_TOKEN_ENV]: token },
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
