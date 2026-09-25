import { browserEvents } from '@core/features/browser/node';
import { previewServerService } from '@core/features/preview-servers/api/node/preview-server-service-instance';
import { previewServerUrl } from '@core/primitives/preview-servers/api';
import { getAppSettingsService } from '@main/bootstrap/core/service-instances';
import { log } from '@main/lib/logger';
import { BrowserAutomation } from './browser-automation';
import { BrowserConsoleBuffer } from './browser-console-buffer';
import { BrowserControlServer } from './browser-control-server';
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
