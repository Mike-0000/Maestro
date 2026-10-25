import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import type { Scope } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import {
  createController,
  forwardController,
  type Contract,
  type ContractDefinitions,
  type ContractImpl,
  type Controller,
} from '@emdash/wire/rpc';
import type { EmdashAccountService } from '@core/features/account/node/services/emdash-account-service';
import { createAccountWireController } from '@core/features/account/node/wire-controller';
import { createAgentAddonsWireController } from '@core/features/agent-addons/node/wire-controller';
import { createAgentOperations } from '@core/features/agents/node/controller';
import { createAgentsWireController } from '@core/features/agents/node/wire-controller';
import type { AutomationsService } from '@core/features/automations/api/node/automations-service';
import { createAutomationsWireController } from '@core/features/automations/node/wire-controller';
import {
  createBrowserWireController,
  type BrowserOperations,
} from '@core/features/browser/node/wire-controller';
import { createCatalogWireController } from '@core/features/catalog/node/wire-controller';
import { createConductorWireController } from '@core/features/conductor/node/wire-controller';
import type { CompensationRunner } from '@core/features/conversations/node/createConversation';
import {
  createConversationsWireController,
  type SessionMcpServersResolver,
} from '@core/features/conversations/node/wire-controller';
import {
  createDevPerfWireController,
  type DevPerfOperations,
} from '@core/features/dev-perf/node/wire-controller';
import type { EditorBufferService } from '@core/features/editor/node/editor-buffer-service';
import { createEditorWireController } from '@core/features/editor/node/wire-controller';
import { createFilesWireController } from '@core/features/files/node/wire-controller';
import type { GitCredentialsService } from '@core/features/github/api/node/services/git-credentials-service';
import { createGithubWireController } from '@core/features/github/node/wire-controller';
import { createIntegrationsWireController } from '@core/features/integrations/node/wire-controller';
import type { IssueProviderRegistry } from '@core/features/issues/node/registry';
import { createIssuesWireController } from '@core/features/issues/node/wire-controller';
import {
  createLegacyPortWireController,
  type LegacyPortControllerOperations,
} from '@core/features/legacy-port/node/wire-controller';
import type { PromptLibraryService } from '@core/features/library/node/prompt-library-service';
import { createPromptLibraryWireController } from '@core/features/library/node/wire-controller';
import type { LocalUpdateService } from '@core/features/local-updates/node/local-update-service';
import { createLocalUpdatesWireController } from '@core/features/local-updates/node/wire-controller';
import { createMachinesWireController } from '@core/features/machines/node/wire-controller';
import { createMarkdownViewerWireController } from '@core/features/markdown-viewer/node/wire-controller';
import { createMcpWireController } from '@core/features/mcp/node/wire-controller';
import type { PreviewServerAccessOperations } from '@core/features/preview-servers/node/preview-server-access-service';
import { createPreviewServersWireController } from '@core/features/preview-servers/node/wire-controller';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { ProjectSettingsService } from '@core/features/projects/api/node/settings/project-settings-service';
import type { ProjectDeletionDependencies } from '@core/features/projects/node/operations/deleteProject';
import { getProjectById } from '@core/features/projects/node/operations/getProjects';
import { createProjectsWireController } from '@core/features/projects/node/wire-controller';
import {
  createRemoteAccessWireController,
  type RemoteAccessOperations,
} from '@core/features/remote-access/node/wire-controller';
import { createRepositoryWireController } from '@core/features/repository/node/wire-controller';
import type { SearchService } from '@core/features/search/node/search-service';
import { createSearchWireController } from '@core/features/search/node/wire-controller';
import { createSkillsWireController } from '@core/features/skills/node/wire-controller';
import { createSourceControlWireController } from '@core/features/source-control/node/wire-controller';
import { createTalkWireController } from '@core/features/talk/node/wire-controller';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import { TaskListService } from '@core/features/tasks/node/task-list-service';
import { createTasksWireController } from '@core/features/tasks/node/wire-controller';
import { createTelemetryWireController } from '@core/features/telemetry/node/wire-controller';
import {
  createTerminalsWireController,
  type CreateTerminalsWireControllerOptions,
} from '@core/features/terminals/node/wire-controller';
import {
  createUpdatesWireController,
  type UpdateOperations,
} from '@core/features/updates/node/wire-controller';
import { createVoiceWireController } from '@core/features/voice/node/wire-controller';
import {
  createDesktopHostWireController,
  type DesktopHostControllerOperations,
} from '@core/features/workbench/node/wire-controller';
import type { WorkspacePlacementResolver } from '@core/features/workspaces/api/node/placement/workspace-placement-resolver';
import { createWorkspaceRegistry } from '@core/features/workspaces/api/node/registry';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import { createLifecycleScriptsWireController } from '@core/features/workspaces/node/lifecycle-scripts-wire-controller';
import {
  createProjectSettingsWireController,
  createProjectWorkspacesWireController,
} from '@core/features/workspaces/node/project-wire-controllers';
import { createWorkspaceRegistryWireController } from '@core/features/workspaces/node/registry-wire-controller';
import {
  createWorkspacesWireController,
  type CreateWorkspacesWireControllerOptions,
} from '@core/features/workspaces/node/wire-controller';
import { WorkspaceMutationService } from '@core/features/workspaces/node/workspace-mutation-service';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import { desktopDomainContracts } from '@core/manifests/shared/domain-contracts';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import type { HostReachabilityProbe } from '@core/primitives/ssh/api';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import type { AppDb } from '@core/services/app-db/node/db';
import type { TerminalFileSources } from '@core/services/attachments/node/prepare-terminal-files';
import type { HostAvailabilityService } from '@core/services/hosts/node/availability';
import type { Hosts } from '@core/services/hosts/node/hosts';
import { createHostsWireController } from '@core/services/hosts/node/wire-controller';
import {
  createLoggingWireController,
  type LoggingControllerOperations,
} from '@core/services/logging/node/wire-controller';
import type { NotificationService } from '@core/services/notifications/node';
import { createNotificationsWireController } from '@core/services/notifications/node/wire-controller';
import type { PullRequestsRuntimeClient } from '@core/services/pull-requests/api';
import type { ReconcileSweepHandle } from '@core/services/reconcile-sweep/node/reconcile-sweep-service';
import type { MementosRuntimeClient } from '@core/services/runtime-broker/api/clients';
import type { AppSettingsService } from '@core/services/settings/node';
import type { ProviderOverrideSettings } from '@core/services/settings/node/provider-settings-service';
import {
  createAppSettingsWireController,
  type SettingsRuntimePort,
} from '@core/services/settings/node/wire-controller';
import { createSshWireController } from '@core/services/ssh/node/controller';

export type DesktopControllerContext = {
  readonly accountService: EmdashAccountService;
  readonly agentDependencies: Omit<
    Parameters<typeof createAgentOperations>[0],
    'providerOverrideSettings'
  >;
  readonly appSettings: AppSettingsService;
  readonly automations: AutomationsService;
  readonly chorus: ChorusHostServices;
  readonly browserOperations: BrowserOperations;
  /** Chorus browser-control MCP servers for local ACP sessions (resolved in main). */
  readonly sessionMcpServers?: SessionMcpServersResolver;
  readonly compensation: CompensationRunner;
  readonly db: AppDb;
  readonly devPerfOperations: DevPerfOperations;
  readonly editorBuffer: EditorBufferService;
  readonly github: Omit<Parameters<typeof createGithubWireController>[0], 'logger'>;
  readonly gitCredentials: GitCredentialsService;
  readonly hostAvailability: HostAvailabilityService;
  readonly hostIsReachable: HostReachabilityProbe;
  readonly hostOperations: DesktopHostControllerOperations;
  readonly issueProviders: IssueProviderRegistry;
  readonly legacyPortOperations: LegacyPortControllerOperations;
  readonly localUpdates: LocalUpdateService;
  readonly logger: Logger;
  readonly loggingOperations: LoggingControllerOperations;
  readonly notifications: NotificationService;
  readonly previewServerAccess: PreviewServerAccessOperations;
  readonly projectDeletion: ProjectDeletionDependencies;
  readonly promptLibrary: PromptLibraryService;
  readonly projects: ProjectAttachmentManager;
  readonly projectSettings: ProjectSettingsService;
  readonly providerSettings: ProviderOverrideSettings;
  readonly reconcileSweep: ReconcileSweepHandle;
  readonly remoteAccessOperations: RemoteAccessOperations;
  readonly hosts: Hosts;
  readonly runtimeClients: {
    getMementosRuntimeClient(): Promise<MementosRuntimeClient>;
    getPullRequestsRuntimeClient(): Promise<PullRequestsRuntimeClient>;
  };
  readonly scope: Scope;
  readonly search: SearchService;
  readonly sessionLaunchContexts: TaskSessionLaunchContextResolver;
  readonly runtimes: RuntimeBroker;
  readonly ssh: SshServiceHandle;
  readonly settingsRuntime: SettingsRuntimePort;
  readonly telemetry: TelemetryService;
  readonly taskService: TaskService;
  readonly taskSessions: TaskSessionManager;
  readonly terminalFileSources: TerminalFileSources;
  readonly terminalShell: CreateTerminalsWireControllerOptions['terminalShell'];
  readonly updateOperations: UpdateOperations;
  readonly workspaceIdentity: WorkspaceIdentityService;
  readonly workspacePlacement: WorkspacePlacementResolver;
  readonly workspaces: Omit<CreateWorkspacesWireControllerOptions, 'db' | 'mutations'>;
};

type DesktopDomain = Extract<keyof typeof desktopDomainContracts, string>;

export type DesktopNodeControllerContribution = {
  readonly create: (context: DesktopControllerContext) => Controller | Promise<Controller>;
};

function controllerFromImpl<Defs extends ContractDefinitions>(
  contract: Contract<Defs>,
  owner: { impl: ContractImpl<Defs>; dispose(): Promise<void> },
  scope: Scope
): Controller {
  scope.add(() => owner.dispose());
  return createController(contract, owner.impl);
}

export const desktopNodeControllers = {
  account: {
    create: ({ accountService, logger, telemetry }) =>
      createAccountWireController(accountService, { logger, telemetry }),
  },
  agents: {
    create: ({ agentDependencies, providerSettings, runtimes }) =>
      createAgentsWireController({
        operations: createAgentOperations({
          ...agentDependencies,
          providerOverrideSettings: providerSettings,
        }),
        runtimes,
      }),
  },
  appSettings: {
    create: ({ appSettings, settingsRuntime }) =>
      createAppSettingsWireController(appSettings, settingsRuntime),
  },
  remoteAccess: {
    create: ({ remoteAccessOperations, scope }) =>
      createRemoteAccessWireController(remoteAccessOperations, scope),
  },
  devPerf: {
    create: ({ devPerfOperations, logger }) =>
      createDevPerfWireController(devPerfOperations, logger),
  },
  editor: {
    create: ({ editorBuffer }) => createEditorWireController({ editorBuffer }),
  },
  files: {
    create: ({ runtimes }) => createFilesWireController({ runtimes }),
  },
  legacyPort: {
    create: ({ legacyPortOperations }) => createLegacyPortWireController(legacyPortOperations),
  },
  localUpdates: {
    create: ({ localUpdates }) => {
      void localUpdates.reconcile();
      return createLocalUpdatesWireController(localUpdates);
    },
  },
  logging: {
    create: ({ loggingOperations }) => createLoggingWireController(loggingOperations),
  },
  machines: {
    create: ({ runtimes, ssh }) =>
      createMachinesWireController(ssh.machines, runtimes, ssh.maestroHosts),
  },
  projectSettings: {
    create: ({ runtimes, workspaceIdentity }) =>
      createProjectSettingsWireController({ runtimes, workspaceIdentity }),
  },
  projectWorkspaces: {
    create: ({ db, projects, runtimes, scope, taskService, taskSessions }) => {
      const controller = createProjectWorkspacesWireController({
        db,
        projects,
        runtimes,
        taskService,
        taskSessions,
      });
      scope.add(() => controller.dispose());
      return controller.controller;
    },
  },
  promptLibrary: {
    create: ({ promptLibrary }) => createPromptLibraryWireController(promptLibrary),
  },
  repository: {
    create: ({ db, projects }) =>
      createRepositoryWireController({
        projects,
        loadProject: (projectId) => getProjectById(db, projectId),
      }),
  },
  search: {
    create: ({ search }) => createSearchWireController(search),
  },
  telemetry: {
    create: ({ telemetry }) => createTelemetryWireController(telemetry),
  },
  sourceControl: {
    create: ({ gitCredentials, runtimes, workspaceIdentity, projects }) =>
      createSourceControlWireController({
        runtimes,
        workspaceIdentity,
        projects,
        mintOperationCredentials: gitCredentials.mintOperationCredentials,
      }),
  },
  mcp: {
    create: ({ runtimes }) => createMcpWireController({ runtimes }),
  },
  skills: {
    create: ({ runtimes }) => createSkillsWireController({ runtimes }),
  },
  agentAddons: {
    create: ({ runtimes }) => createAgentAddonsWireController({ runtimes }),
  },
  terminals: {
    create: ({
      appSettings,
      db,
      terminalFileSources,
      gitCredentials,
      logger,
      localUpdates,
      projects,
      runtimes,
      sessionLaunchContexts,
      telemetry,
      terminalShell,
      workspaceIdentity,
    }) =>
      createTerminalsWireController({
        terminalFileSources,
        db,
        localUpdates,
        projects,
        runtimes,
        sessionLaunchContexts,
        settings: appSettings,
        logger,
        telemetry,
        terminalShell,
        workspaceIdentity,
        resolveSessionGitCredentials: gitCredentials.resolveSessionSpec,
      }),
  },
  mementos: {
    create: async ({ runtimeClients }) =>
      forwardController(
        desktopDomainContracts.mementos,
        await runtimeClients.getMementosRuntimeClient()
      ),
  },
  notifications: {
    create: ({ notifications }) => createNotificationsWireController(notifications),
  },
  pullRequests: {
    create: async ({ runtimeClients }) =>
      forwardController(
        desktopDomainContracts.pullRequests,
        await runtimeClients.getPullRequestsRuntimeClient()
      ),
  },
  catalog: {
    create: ({ scope }) =>
      controllerFromImpl(desktopDomainContracts.catalog, createCatalogWireController(), scope),
  },
  workspaces: {
    create: ({ db, projects, runtimes, scope, workspaces }) => {
      const mutations = new WorkspaceMutationService({ db, projects, runtimes });
      return controllerFromImpl(
        desktopDomainContracts.workspaces,
        createWorkspacesWireController({
          ...workspaces,
          db,
          mutations,
        }),
        scope
      );
    },
  },
  workspaceRegistry: {
    create: ({ db, reconcileSweep, runtimes }) =>
      createWorkspaceRegistryWireController({ db, runtimes, sweep: reconcileSweep }),
  },
  lifecycleScripts: {
    create: ({ runtimes, workspaceIdentity }) =>
      createLifecycleScriptsWireController({ runtimes, workspaceIdentity }),
  },
  projects: {
    create: ({
      db,
      gitCredentials,
      projectDeletion,
      projects,
      projectSettings,
      runtimes,
      scope,
      workspacePlacement,
    }) =>
      controllerFromImpl(
        desktopDomainContracts.projects,
        createProjectsWireController({
          db,
          placement: workspacePlacement,
          projectDeletion,
          projects,
          projectSettings,
          runtimes,
          mintCloneCredentials: gitCredentials.mintCloneCredentials,
        }),
        scope
      ),
  },
  automations: {
    create: ({ automations, db, logger, runtimes, taskService }) =>
      createAutomationsWireController({
        db,
        getProjectById: (projectId) => getProjectById(db, projectId),
        logger,
        runtime: {
          runtimes,
          getProjectById: (projectId) => getProjectById(db, projectId),
        },
        service: automations,
        taskService,
      }),
  },
  browser: {
    create: ({ browserOperations }) => createBrowserWireController(browserOperations),
  },
  conversations: {
    create: ({
      sessionMcpServers,
      compensation,
      db,
      terminalFileSources,
      hostIsReachable,
      logger,
      projects,
      providerSettings,
      runtimes,
      sessionLaunchContexts,
      taskSessions,
      telemetry,
      localUpdates,
      workspaceIdentity,
    }) =>
      createConversationsWireController({
        terminalFileSources,
        db,
        logger,
        projects,
        getProviderEnv: async (providerId) => (await providerSettings.getItem(providerId))?.env,
        getSessionMcpServers: sessionMcpServers,
        sessionLaunchContexts,
        runtimes,
        taskSessions,
        telemetry,
        workspaceIdentity,
        withCompensation: compensation,
        hostIsReachable,
        localUpdates,
      }),
  },
  previewServers: {
    create: ({ previewServerAccess }) => createPreviewServersWireController(previewServerAccess),
  },
  github: {
    create: ({ github, logger }) => createGithubWireController({ ...github, logger }),
  },
  integrations: {
    create: () => createIntegrationsWireController(),
  },
  issues: {
    create: ({ issueProviders, projects }) =>
      createIssuesWireController({ projects, providers: issueProviders }),
  },
  ssh: {
    create: ({ ssh }) => createSshWireController(ssh.ssh, ssh.connections),
  },
  hosts: {
    create: ({ hostAvailability, hosts, ssh }) =>
      createHostsWireController(hosts, hostAvailability, ssh.ssh),
  },
  tasks: {
    create: ({ db, localUpdates, scope, taskService, taskSessions, telemetry }) => {
      const taskList = new TaskListService({
        taskService,
        taskSessions,
        workspaces: createWorkspaceRegistry(db),
      });
      return controllerFromImpl(
        desktopDomainContracts.tasks,
        createTasksWireController({
          db,
          service: taskService,
          taskList,
          telemetry,
          localUpdates,
        }),
        scope
      );
    },
  },
  updates: {
    create: ({ updateOperations }) => createUpdatesWireController(updateOperations),
  },
  host: {
    create: ({ hostOperations }) => createDesktopHostWireController(hostOperations),
  },
  voice: {
    create: ({ chorus, logger, scope }) =>
      createVoiceWireController({ host: chorus, logger, scope }).controller,
  },
  conductor: {
    create: ({
      agentDependencies,
      chorus,
      logger,
      providerSettings,
      scope,
      search,
      ssh,
      workspaceIdentity,
    }) =>
      createConductorWireController({
        host: chorus,
        logger,
        scope,
        // Built here because a slice may not import another slice's node surface.
        investigator: {
          // The resolver alone, not a probe: probing would refresh every dependency.
          resolveCli: async () => {
            const manager = await agentDependencies.getDependencyManager();
            if (!manager.success) return null;
            const resolved = await manager.data.resolver.resolve({ id: 'claude' });
            return resolved.success ? resolved.data.path : null;
          },
          providerEnv: async () => (await providerSettings.getItem('claude'))?.env ?? {},
          // The object itself: its methods use `this`, so they are not passed detached.
          identity: workspaceIdentity,
          // A WSL project is read through the Windows folder its live mirror keeps the same.
          wslMirrors: () => ssh.machines.getWslMirrors(),
        },
        lookup: {
          searchFiles: async (workspaceId, query, limit) =>
            (await search.searchFiles(workspaceId, query, limit)).map((hit) => hit.relativePath),
          searchContent: async (workspaceId, query, limit, signal) => {
            const result = await search.searchContent(
              { workspaceId, query, limit },
              { jobId: 'conductor-lookup', signal, progress: () => {} }
            );
            if (!result.success) return null;
            return {
              files: result.data.files.map((file) => ({
                path: file.path,
                lines: file.matches.length,
              })),
              complete: result.data.complete,
            };
          },
        },
      }),
  },
  talk: {
    create: ({ chorus, logger }) => createTalkWireController({ host: chorus, logger }),
  },
  markdownViewer: {
    create: ({ workspaceIdentity }) => createMarkdownViewerWireController({ workspaceIdentity }),
  },
} satisfies {
  readonly [Domain in DesktopDomain]: DesktopNodeControllerContribution;
};
