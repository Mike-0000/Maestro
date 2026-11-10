import { providerTokenRegistry } from '@core/features/account/api/node/provider-token-registry';
import type { EmdashAccountService } from '@core/features/account/node/services/emdash-account-service';
import { claudeAccountsEvents } from '@core/features/claude-accounts/node/event-host';
import { createClaudeLimitSwitchService } from '@core/features/claude-accounts/node/limit-switch-service';
import type { ClaudeAccountMover } from '@core/features/conversations/node/claude-account-move';
import {
  createClaudeAccountMoveRuntime,
  createClaudeConversationSignals,
} from '@core/features/conversations/node/claude-account-move-runtime';
import { createConversationRuntimeTargetResolver } from '@core/features/conversations/node/wire-controller';
import { GitHubAuthServerAdapter } from '@core/features/github/node/accounts/github-auth-server-adapter';
import { getIntegrationConnectionService } from '@core/features/integrations/node/integration-connection-service';
import { createLocalUpdateService } from '@core/features/local-updates/node/local-update-service';
import { provisionWorkspaceErrorToWorkspaceError } from '@core/features/workspaces/node/wire-controller';
import type { DesktopControllerContext } from '@core/manifests/node/controllers';
import { agentStatusService } from '@main/core/agent-status/agent-status-service';
import { appOperations } from '@main/core/app/controller';
import { terminalFileSources } from '@main/core/app/persist-terminal-attachment';
import {
  createDependencyManagerResolver,
  ensureAgentDependenciesProbed,
} from '@main/core/dependencies/dependency-managers';
import { getTerminalColorEnv } from '@main/core/terminal-shell/color-env';
import { withCompensation } from '@main/core/utils/compensation';
import { legacyPortOperations } from '@main/db/legacy-port/controller';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { resolveAgentSessionMcpServers } from '@main/host/agent-requests/agent-session-mcp';
import { setBrowserCorsRelaxationSettings } from '@main/host/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/host/browser/browser-webcontents-registry';
import { browserOperations } from '@main/host/browser/controller';
import { createChorusHostServices } from '@main/host/chorus-host';
import { createDevPerfOperations } from '@main/host/dev-perf/controller-operations';
import { writeRendererLogEntry } from '@main/host/file-logger';
import { remoteAccessService } from '@main/host/remote-access/remote-access-service';
import { getActiveSessionSummary } from '@main/host/sessions/active-session-summary';
import { setTrayVisible } from '@main/host/tray';
import { updateOperations } from '@main/host/updates/controller-operations';
import { applyNativeTheme } from '@main/host/window';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { appScope } from '../core/app-scope';
import type { DatabaseBundle } from './phases/database';
import type { ServicesBundle } from './phases/services';

export function wireAccountTelemetry(accountService: EmdashAccountService): void {
  accountService.on('accountChanged', (username, userId, email) => {
    void telemetryService.identify(username, userId, email);
  });
  accountService.on('accountCleared', () => {
    telemetryService.clearIdentity();
  });
}

export function registerProviderTokenHandlers(): void {
  const githubAuthServerAdapter = new GitHubAuthServerAdapter(getIntegrationConnectionService());
  providerTokenRegistry.register('github', (payload) =>
    githubAuthServerAdapter.storeOAuthToken(payload)
  );
}

export type DesktopControllerOptions = Omit<
  DesktopControllerContext,
  'hosts' | 'runtimes' | 'scope' | 'ssh'
>;

export function createDesktopWireOptions(
  database: DatabaseBundle,
  services: ServicesBundle,
  runtimes: DesktopRuntimes
): DesktopControllerOptions {
  const taskService = services.taskService;
  const github = services.github;
  const chorus = createChorusHostServices();
  const localUpdates = createLocalUpdateService(database.db, chorus, {
    getActiveSessionSummary: () =>
      getActiveSessionSummary(runtimes.broker, services.hostAttachments.attachedHosts()),
  });
  const getDependencyManager = createDependencyManagerResolver(runtimes.clients.hostDependencies);
  const claudeAccountMoves = createClaudeAccountSwitching(
    database,
    services,
    runtimes,
    localUpdates
  );
  return {
    terminalFileSources,
    accountService: services.account,
    agentDependencies: {
      ensureAgentDependenciesProbed,
      getDependencyManager,
    },
    appSettings: database.appSettings,
    automations: services.automations,
    chorus,
    claudeAccounts: services.claudeAccounts,
    claudeUsage: services.claudeUsage,
    claudeAccountMoves,
    localUpdates,
    browserOperations,
    sessionMcpServers: resolveAgentSessionMcpServers,
    compensation: withCompensation,
    db: database.db,
    devPerfOperations: createDevPerfOperations(runtimes),
    editorBuffer: database.editorBuffer,
    github: {
      cliAccountImporter: github.cliImport,
      deviceFlowService: github.deviceFlow,
      repositoryService: github.repositories,
    },
    gitCredentials: services.gitCredentials,
    hostAvailability: runtimes.hostAvailability,
    hostOperations: {
      openExternal: ({ url }) => appOperations.openExternal(url),
      openPath: ({ ref }) => appOperations.openPath(ref),
      showWorkspaceItemInFolder: (input) => appOperations.showWorkspaceItemInFolder(input),
      clipboardWriteText: ({ text }) => appOperations.clipboardWriteText(text),
      persistDroppedBlob: (input) => appOperations.persistDroppedBlob(input),
      persistClipboardImage: () => appOperations.persistClipboardImage(),
      showTerminalContextMenu: (input) => appOperations.showTerminalContextMenu(input),
      setMenuKeybindings: (input) => appOperations.setMenuKeybindings(input),
      quit: () => appOperations.quit(),
      resolveQuitConfirmation: (input) => appOperations.resolveQuitConfirmation(input),
      ackShutdownFlush: () => appOperations.ackShutdownFlush(),
      shutdownReady: () => appOperations.shutdownReady(),
      openIn: (input) => appOperations.openIn(input),
      checkInstalledApps: () => appOperations.checkInstalledApps(),
      listInstalledFonts: (input) => appOperations.listInstalledFonts(input),
      openSelectDirectoryDialog: (input) => appOperations.openSelectDirectoryDialog(input),
      openSelectAudioFileDialog: (input) => appOperations.openSelectAudioFileDialog(input),
      saveTextFile: (input) => appOperations.saveTextFile(input),
      readAudioFileDataUrl: ({ filePath }) => appOperations.readAudioFileDataUrl(filePath),
      minimizeWindow: () => appOperations.minimizeWindow(),
      toggleMaximizeWindow: () => appOperations.toggleMaximizeWindow(),
      closeWindow: () => appOperations.closeWindow(),
      isWindowMaximized: () => appOperations.isWindowMaximized(),
      getAppVersion: () => appOperations.getAppVersion(),
      getElectronVersion: () => appOperations.getElectronVersion(),
      getPlatform: () => appOperations.getPlatform(),
      getPlatformDisplayName: () => appOperations.getPlatformDisplayName(),
      getDiagnosticLogAttachment: () => appOperations.getDiagnosticLogAttachment(),
      submitFeedback: (input) => appOperations.submitFeedback(input),
    },
    hostIsReachable: services.hostIsReachable,
    issueProviders: services.issueProviders,
    legacyPortOperations,
    logger: log,
    loggingOperations: {
      writeRendererLog: (input) => writeRendererLogEntry(input),
    },
    notifications: services.notifications,
    previewServerAccess: services.previewServerAccess,
    projectDeletion: services.projectDeletion,
    promptLibrary: services.promptLibrary,
    projects: services.projects,
    projectSettings: services.projectSettings,
    providerSettings: services.providerSettings,
    reconcileSweep: services.reconcileSweep,
    remoteAccessOperations: remoteAccessService.operations,
    search: services.search,
    sessionLaunchContexts: services.sessionLaunchContexts,
    runtimeClients: {
      getMementosRuntimeClient: async () => runtimes.clients.mementos,
      getPullRequestsRuntimeClient: async () => runtimes.clients.pullRequests,
    },
    settingsRuntime: {
      setKeyboardSettings: (settings) => browserWebContentsRegistry.setKeyboardSettings(settings),
      setBrowserSettings: setBrowserCorsRelaxationSettings,
      setTheme: applyNativeTheme,
      setTrayVisible,
    },
    telemetry: telemetryService,
    taskService,
    taskSessions: services.taskSessions,
    terminalShell: {
      getColorEnv: getTerminalColorEnv,
    },
    updateOperations,
    workspaceIdentity: database.workspaceIdentity,
    workspacePlacement: services.workspacePlacement,
    workspaces: {
      async provisionTask(taskId, signal) {
        const result = await taskService.provisionWorkspace(taskId, signal);
        return result.success
          ? result
          : { success: false, error: provisionWorkspaceErrorToWorkspaceError(result.error) };
      },
      reprovisionWorkspace: (workspaceId, options) =>
        taskService.reprovisionWorkspace(workspaceId, options),
    },
  };
}

/**
 * Moving Claude conversations between accounts: the mover behind `conversations.moveClaudeAccount`
 * and the service that moves a conversation by itself when its account hits a usage limit. Both
 * share one mover, so moves of one conversation never overlap.
 */
function createClaudeAccountSwitching(
  database: DatabaseBundle,
  services: ServicesBundle,
  runtimes: DesktopRuntimes,
  localUpdates: ReturnType<typeof createLocalUpdateService>
): ClaudeAccountMover {
  const { claudeAccounts, providerSettings } = services;
  const accounts = {
    list: () => claudeAccounts.list(),
    resolveAccountId: (explicit?: string) => claudeAccounts.resolveAccountId(explicit),
    // Cached answers (a minute) are enough here: the switch has just forced a refresh.
    hasFreshUsage: async (accountId: string) =>
      (await services.claudeUsage.usage({ accountId }))[0]?.status === 'fresh',
    resolve: (accountId: string | undefined) => claudeAccounts.resolve(accountId),
    prepare: (launch: Parameters<typeof claudeAccounts.prepare>[0]) =>
      claudeAccounts.prepare(launch),
  };
  const mover = createClaudeAccountMoveRuntime({
    db: database.db,
    runtimes: runtimes.broker,
    hostIsReachable: services.hostIsReachable,
    projects: services.projects,
    taskSessions: services.taskSessions,
    // The same launch the conversations controller builds, so a moved session starts as any other.
    resolveTarget: createConversationRuntimeTargetResolver({
      db: database.db,
      workspaceIdentity: database.workspaceIdentity,
      getProviderEnv: async (providerId) => (await providerSettings.getItem(providerId))?.env,
      sessionLaunchContexts: services.sessionLaunchContexts,
      getSessionMcpServers: resolveAgentSessionMcpServers,
      claudeAccounts: accounts,
    }),
    claudeAccounts: accounts,
    getProviderConfig: (providerId) => providerSettings.getItem(providerId),
    recordWorkStarted: localUpdates.recordWorkStarted,
    recordInputSubmitted: localUpdates.recordInputSubmitted,
    onMoved: (moved) =>
      claudeAccountsEvents.emit(undefined, { type: 'conversation-moved', ...moved }),
    logger: log,
  });
  const signals = createClaudeConversationSignals(runtimes.broker);
  const limitSwitch = createClaudeLimitSwitchService({
    enabled: () => claudeAccounts.autoSwitchOnLimit(),
    accounts: () => claudeAccounts.list(),
    usage: (input) => services.claudeUsage.usage(input),
    describe: (conversationId) => mover.describe(conversationId),
    terminalTail: (conversationId) => signals.terminalTail(conversationId).catch(() => null),
    lastChatReply: (conversationId) => signals.lastChatReply(conversationId).catch(() => null),
    move: (input) => mover.move(input),
    emit: (event) => claudeAccountsEvents.emit(undefined, event),
    logger: log,
    now: () => Date.now(),
  });
  const unsubscribe = agentStatusService.on('agent:event', (event) =>
    limitSwitch.handleAgentEvent(event)
  );
  appScope.add(() => {
    unsubscribe();
    limitSwitch.dispose();
  });
  return mover;
}
