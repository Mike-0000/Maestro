import { hostname } from 'node:os';
import { join } from 'node:path';
import { formatHostRef } from '@emdash/core/primitives/host/api';
import { app } from 'electron';
import { updateInstalledAddons } from '@core/features/agent-addons/node/auto-update';
import { conversationEvents } from '@core/features/conversations/api/node/conversation-events';
import { emitConversationWireEvent } from '@core/features/conversations/node/event-host';
import { loadActiveAgentStatusConversationIds } from '@core/features/conversations/node/load-active-agent-status-conversation-ids';
import { renameConversation } from '@core/features/conversations/node/renameConversation';
import { setConductorDecisionHost } from '@core/primitives/agents/api/conductor-decisions';
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge';
import {
  agentStatusService,
  setAgentStatusConversationEventPublisher,
} from '@main/core/agent-status/agent-status-service';
import { tuiAgentStatusBridge } from '@main/core/agent-status/tui-agent-status-bridge';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import {
  createDesktopWireController,
  installDesktopWire,
  registerDesktopWireControllers,
} from '@main/gateway/desktop-wire';
import { createDesktopDevServerBridgeParticipant } from '@main/gateway/dev-server-bridge';
import { remoteAccessService } from '@main/host/remote-access/remote-access-service';
import { encryptedAppSecretsStore } from '@main/host/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { appScope } from '../../core/app-scope';
import { runInBackground } from '../../core/background';
import type { ControllersBundle } from './controllers';
import type { DatabaseBundle } from './database';
import type { ServicesBundle } from './services';

export function installGateway(
  controllers: ControllersBundle,
  database: DatabaseBundle,
  services: ServicesBundle,
  runtimes: DesktopRuntimes
): void {
  installDesktopWire();
  registerDesktopWireControllers(controllers);
  const devServerBridgeParticipant = createDesktopDevServerBridgeParticipant(
    runtimes.broker,
    database.workspaceIdentity
  );

  acpAgentStatusBridge.initialize(
    (handler) => conversationEvents.on('conversation:created', handler),
    {
      runtimes: runtimes.broker,
      onLocalWorkerStateChanged: runtimes.workers.acp.onStateChanged.bind(runtimes.workers.acp),
      loadActiveConversationIds: (host) =>
        loadActiveAgentStatusConversationIds(database.db, host, 'acp'),
      renameConversation: (conversationId, name) =>
        renameConversation(
          {
            db: database.db,
            runtimes: runtimes.broker,
            hostIsReachable: services.hostIsReachable,
          },
          conversationId,
          name
        ),
    }
  );
  const publishConversationEvent = emitConversationWireEvent;
  setAgentStatusConversationEventPublisher(publishConversationEvent);
  // Chat conductors decide needs-you and done for the conversations they claim.
  setConductorDecisionHost(agentStatusService.decisions);
  tuiAgentStatusBridge.initialize({
    runtimes: runtimes.broker,
    onLocalWorkerStateChanged: runtimes.workers.tuiAgents.onStateChanged.bind(
      runtimes.workers.tuiAgents
    ),
    loadActiveConversationIds: (host) =>
      loadActiveAgentStatusConversationIds(database.db, host, 'pty'),
  });
  appScope.add(services.hostAttachments.register(devServerBridgeParticipant));
  appScope.add(
    services.hostAttachments.register({
      label: 'acp-agent-status',
      attach: (host) => acpAgentStatusBridge.attachHost(host),
      detach: (host) => acpAgentStatusBridge.detachHost(host),
    })
  );
  appScope.add(
    services.hostAttachments.register({
      label: 'tui-agent-status',
      attach: (host) => tuiAgentStatusBridge.attachHost(host),
      detach: (host) => tuiAgentStatusBridge.detachHost(host),
    })
  );

  // Maestro updates bring new add-on versions (such as the vibe skill); bring each host's
  // installed copies up to date when it attaches. Fire-and-forget so a slow host never blocks
  // the per-host attachment chain; edited files are left alone and reported as conflicts.
  appScope.add(
    services.hostAttachments.register({
      label: 'agent-addons-auto-update',
      attach: (host) => {
        runInBackground('agent-addons-auto-update', async () => {
          const outcomes = await updateInstalledAddons({ runtimes: runtimes.broker, host });
          for (const outcome of outcomes) {
            const message = `Add-on ${outcome.addonId} for ${outcome.providerId} on ${formatHostRef(host)}: v${outcome.from} -> v${outcome.to} ${outcome.result}`;
            if (outcome.result === 'updated') log.info(message);
            else log.warn(message, { detail: outcome.detail });
          }
        });
      },
      detach: () => {},
    })
  );

  appScope.add(() => remoteAccessService.dispose());
  runInBackground('remote-access', () =>
    remoteAccessService.attach({
      db: database.db,
      clients: runtimes.clients,
      desktopController: createDesktopWireController(),
      taskService: services.taskService,
      dataDirectory: app.getPath('userData'),
      staticRoot: join(app.getAppPath(), 'out', 'remote-web'),
      appVersion: app.getVersion(),
      hostName: hostname(),
      logger: log,
      notifications: services.notifications,
      notificationsEnabled: async () => (await database.appSettings.get('notifications')).enabled,
      secrets: encryptedAppSecretsStore,
    })
  );

  runInBackground('account-session', async () => {
    const result = await services.account.initialize();
    if (!result.success) {
      log.warn('Failed to load account session token:', result.error);
    }
  });
}
