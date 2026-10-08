import { randomUUID } from 'node:crypto';
import type { TuiAgentState, TuiSessionState } from '@emdash/core/runtimes/tui-agents/api';
import {
  remoteDeviceWireContract,
  type RemoteAgent,
  type RemoteAgentStatus,
  type RemoteControlError,
  type RemoteOverview,
  type RemoteProject,
  type RemoteProvider,
} from '@emdash/core/services/remote-control/api';
import { err, ok, type Result, type Unsubscribe } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import type { ContractImpl, LiveSource } from '@emdash/wire/rpc';
import { expose, query, type Query } from '@emdash/wire/state';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  createConversationRegistry,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import type {
  CreateTaskError,
  CreateTaskParams,
  CreateTaskSuccess,
} from '@core/primitives/tasks/api';
import { sameHostPath } from '@core/primitives/workspaces/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projects, tasks } from '@core/services/app-db/node/schema';

// Endpoint ids come from where a contract is mounted, so the implementation is built against
// the mounted definitions (`remote.*`), which every host endpoint shares.
const remoteContract = remoteDeviceWireContract.remote;

export type RemoteControlImpl = ContractImpl<typeof remoteContract>;

type Failure = { success: false; error: { type?: string; message?: string } };

/** What remote control needs from the rest of the app; every verb is the one the window uses. */
export type RemoteControlPorts = {
  db: AppDb;
  hostInfo(): RemoteOverview['host'];
  listProviders(): Promise<RemoteProvider[]>;
  createTask(params: CreateTaskParams): Promise<Result<CreateTaskSuccess, CreateTaskError>>;
  /** Activates the task's workspace and registers its session; a no-op when already active. */
  provisionTask(taskId: string): Promise<{ success: true } | Failure>;
  hydrateConversation(input: {
    projectId: string;
    taskId: string;
    conversationId: string;
    initialSize?: { cols: number; rows: number };
  }): Promise<{ success: true } | Failure>;
  linkConversationToTask(input: {
    conversationId: string;
    projectId: string;
    taskId: string;
  }): Promise<void>;
  terminal: {
    output(conversationId: string): LiveSource | Promise<LiveSource>;
    sendInput(input: {
      conversationId: string;
      data: string;
    }): Promise<{ success: true } | Failure>;
    resize(input: {
      conversationId: string;
      cols: number;
      rows: number;
    }): Promise<{ success: true } | Failure>;
  };
  /** Live agent detail the status bridge already tracks for every attached host. */
  sessions: {
    describe(conversationId: string): { agent?: TuiAgentState; session?: TuiSessionState };
    onChanged(listener: () => void): Unsubscribe;
  };
};

export type RemoteControl = {
  impl: RemoteControlImpl;
  dispose(): void;
};

const DEFAULT_TERMINAL_SIZE = { cols: 120, rows: 36 };
const ADOPTION_WAIT_MS = 20_000;
const ADOPTION_POLL_MS = 250;
const PREFERRED_PROVIDER_ID = 'claude';
const TASK_NAME_LIMIT = 60;

export function createRemoteControl(ports: RemoteControlPorts, scope: Scope): RemoteControl {
  const overview: Query<RemoteOverview> = query({
    name: 'remote-control-overview',
    fetch: () => loadOverview(ports),
    pokes: [
      appDbPokes.projects.subscription(),
      appDbPokes.tasks.subscription(),
      appDbPokes.conversations.subscription(),
      appDbPokes.workspaces.subscription(),
    ],
    debounceMs: 100,
    // Statuses of agents on other machines converge through the registry without a poke.
    revalidateEveryMs: 15_000,
    scope,
  });
  const stopSessionUpdates = ports.sessions.onChanged(() => overview.invalidate());
  const adoptions = new Map<string, Promise<Result<AdoptedTask, RemoteControlError>>>();

  const impl: RemoteControlImpl = {
    overview: expose(remoteContract.overview, { snapshot: overview }, { scope }),

    startAgent: async ({ projectId, prompt, name, providerId }) => {
      const project = findProject(ports.db, projectId);
      if (!project) return err(notFound('That project is no longer open on the host.'));
      if (!project.repositoryWorkspaceId) {
        return err(unavailable('The project directory is not registered yet.'));
      }
      const provider = await pickProvider(ports, providerId);
      if (!provider) return err(notFound('That agent is not available on the host.'));

      const taskId = randomUUID();
      const conversationId = randomUUID();
      const trimmedPrompt = prompt.trim();
      const created = await ports.createTask({
        id: taskId,
        projectId,
        taskConfig: {
          version: '1',
          name: name?.trim() || taskNameFromPrompt(trimmedPrompt),
          initialConversation: {
            id: conversationId,
            provider: provider.id,
            title: provider.name,
            autoApprove: false,
            type: 'pty',
            ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
          },
        },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'repository-instance', workspaceId: project.repositoryWorkspaceId },
        },
      });
      if (!created.success) return err(failed(describeCreateTaskError(created.error)));

      const started = await ensureSession(ports, { projectId, taskId, conversationId });
      if (!started.success) return started;
      return ok({ taskId, conversationId });
    },

    openAgent: async ({ conversationId, size }) => {
      const row = findLinkedConversation(ports.db, conversationId);
      if (!row) return err(notFound('That agent no longer exists on the host.'));
      const kind = row.type === 'acp' ? 'chat' : 'terminal';
      if (kind === 'terminal') {
        const started = await ensureSession(ports, {
          projectId: row.projectId,
          taskId: row.taskId,
          conversationId,
          initialSize: size,
        });
        if (!started.success) return started;
      }
      const { session } = ports.sessions.describe(conversationId);
      return ok({
        kind,
        running: session ? session.status !== 'exited' : false,
        size: session ? { cols: session.cols, rows: session.rows } : null,
      });
    },

    output: ({ conversationId }) => ports.terminal.output(conversationId),

    sendInput: async (input) => toRemoteResult(await ports.terminal.sendInput(input)),

    resize: async (input) => toRemoteResult(await ports.terminal.resize(input)),

    adoptConversation: (input) => {
      const inFlight = adoptions.get(input.conversationId);
      if (inFlight) return inFlight;
      const adoption = adoptConversation(ports, input).finally(() =>
        adoptions.delete(input.conversationId)
      );
      adoptions.set(input.conversationId, adoption);
      return adoption;
    },
  };

  return {
    impl,
    dispose() {
      stopSessionUpdates();
      overview.dispose();
    },
  };
}

type AdoptedTask = { taskId: string; projectId: string };

async function ensureSession(
  ports: RemoteControlPorts,
  input: {
    projectId: string;
    taskId: string;
    conversationId: string;
    initialSize?: { cols: number; rows: number };
  }
): Promise<Result<void, RemoteControlError>> {
  const provisioned = await ports.provisionTask(input.taskId);
  if (!provisioned.success) {
    return err(unavailable(provisioned.error.message ?? 'The task workspace could not be opened.'));
  }
  const hydrated = await ports.hydrateConversation({
    ...input,
    initialSize: input.initialSize ?? DEFAULT_TERMINAL_SIZE,
  });
  if (!hydrated.success) {
    return err(unavailable(hydrated.error.message ?? 'The agent could not be started.'));
  }
  return ok<void>();
}

/**
 * A conversation another Maestro started on this host reaches the registry through the
 * conversation index a moment after it is created, and a worktree it made reaches the
 * workspace mirror the same way; both are waited for rather than refused.
 */
async function adoptConversation(
  ports: RemoteControlPorts,
  input: { conversationId: string; taskName: string; workspacePath: string }
): Promise<Result<AdoptedTask, RemoteControlError>> {
  const registry = createConversationRegistry(ports.db);
  const deadline = Date.now() + ADOPTION_WAIT_MS;
  for (;;) {
    const row = registry.getLive(input.conversationId);
    if (row?.taskId && row.projectId) return ok({ taskId: row.taskId, projectId: row.projectId });

    const target = row ? findLocalWorkspaceProject(ports.db, input.workspacePath) : undefined;
    if (row && target) {
      const taskId = randomUUID();
      const created = await ports.createTask({
        id: taskId,
        projectId: target.projectId,
        taskConfig: { version: '1', name: input.taskName },
        workspaceConfig: {
          version: '2',
          git: { kind: 'none' },
          workspace: { kind: 'repository-instance', workspaceId: target.workspaceId },
        },
      });
      if (!created.success) return err(failed(describeCreateTaskError(created.error)));
      // The task view opens its initial conversation by itself, so the adopted one is marked.
      registry.annotate(input.conversationId, { isInitialConversation: true });
      await ports.linkConversationToTask({
        conversationId: input.conversationId,
        projectId: target.projectId,
        taskId,
      });
      return ok({ taskId, projectId: target.projectId });
    }

    if (Date.now() >= deadline) {
      return err(
        notFound(
          row
            ? `No project on the host contains ${input.workspacePath}. Add it as a project there.`
            : 'The host has not seen that conversation yet.'
        )
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ADOPTION_POLL_MS));
  }
}

function findLocalWorkspaceProject(
  db: AppDb,
  workspacePath: string
): { workspaceId: string; projectId: string } | undefined {
  const candidates = db
    .select({ id: workspaces.id, path: workspaces.path, parentId: workspaces.parentId })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.location, 'local'),
        isNull(workspaces.sshConnectionId),
        isNull(workspaces.deletionTombstone),
        isNotNull(workspaces.path)
      )
    )
    .all();
  const workspace = candidates.find((row) => row.path && sameHostPath(row.path, workspacePath));
  if (!workspace) return undefined;
  const [project] = db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        eq(projects.repositoryWorkspaceId, workspace.parentId ?? workspace.id)
      )
    )
    .limit(1)
    .all();
  return project ? { workspaceId: workspace.id, projectId: project.id } : undefined;
}

function findProject(
  db: AppDb,
  projectId: string
): { id: string; repositoryWorkspaceId: string | null } | undefined {
  return db
    .select({ id: projects.id, repositoryWorkspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1)
    .all()[0];
}

function findLinkedConversation(
  db: AppDb,
  conversationId: string
): { projectId: string; taskId: string; type: string | null } | undefined {
  const [row] = db
    .select({
      projectId: conversations.projectId,
      taskId: conversations.taskId,
      type: conversations.type,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), liveConversations()))
    .limit(1)
    .all();
  if (!row?.projectId || !row.taskId) return undefined;
  return { projectId: row.projectId, taskId: row.taskId, type: row.type };
}

async function pickProvider(
  ports: RemoteControlPorts,
  requested: string | undefined
): Promise<RemoteProvider | undefined> {
  const providers = await ports.listProviders();
  if (requested) return providers.find((provider) => provider.id === requested);
  return defaultProvider(providers);
}

function defaultProvider(providers: readonly RemoteProvider[]): RemoteProvider | undefined {
  return providers.find((provider) => provider.id === PREFERRED_PROVIDER_ID) ?? providers[0];
}

export async function loadOverview(ports: RemoteControlPorts): Promise<RemoteOverview> {
  const { db } = ports;
  const projectRows = db
    .select({
      id: projects.id,
      name: projects.name,
      path: workspaces.path,
      location: workspaces.location,
    })
    .from(projects)
    .leftJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
    .where(isNull(projects.deletedAt))
    .all();
  const taskRows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      name: tasks.name,
      archivedAt: tasks.archivedAt,
    })
    .from(tasks)
    .where(isNull(tasks.deletedAt))
    .all();
  const conversationRows = db
    .select({
      id: conversations.id,
      taskId: conversations.taskId,
      projectId: conversations.projectId,
      title: conversations.title,
      provider: conversations.provider,
      type: conversations.type,
      agentStatus: conversations.agentStatus,
      lastSessionActivityAt: conversations.lastSessionActivityAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        liveConversations(),
        isNotNull(conversations.taskId),
        isNull(conversations.deletionTombstone)
      )
    )
    .all();

  const projectIds = new Set(projectRows.map((project) => project.id));
  const taskById = new Map(taskRows.map((task) => [task.id, task]));
  const remoteProjects: RemoteProject[] = projectRows
    .map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path ?? '',
      local: project.location !== 'remote',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const agents: RemoteAgent[] = [];
  for (const row of conversationRows) {
    const task = row.taskId ? taskById.get(row.taskId) : undefined;
    if (!task || !projectIds.has(task.projectId)) continue;
    const { agent, session } = ports.sessions.describe(row.id);
    const kind = row.type === 'acp' ? 'chat' : 'terminal';
    const status = agentStatus(agent?.status ?? row.agentStatus);
    agents.push({
      conversationId: row.id,
      taskId: task.id,
      projectId: task.projectId,
      taskName: task.name,
      title: row.title,
      providerId: row.provider ?? '',
      kind,
      status,
      running: session ? session.status !== 'exited' : status === 'working',
      needsAttention: status === 'awaiting-input',
      ...(agent?.message ? { message: agent.message } : {}),
      ...(agent?.lastAssistantMessage ? { lastAssistantMessage: agent.lastAssistantMessage } : {}),
      lastActivityAt: latestActivity(
        agent?.updatedAt,
        session?.lastOutputAt,
        parseTimestamp(row.lastSessionActivityAt ?? row.updatedAt)
      ),
      archived: task.archivedAt !== null,
    });
  }
  agents.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  const providers = await ports.listProviders();
  return {
    host: ports.hostInfo(),
    projects: remoteProjects,
    agents,
    providers,
    defaultProviderId: defaultProvider(providers)?.id ?? null,
  };
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<RemoteAgentStatus>([
  'idle',
  'working',
  'awaiting-input',
  'error',
  'completed',
]);

function agentStatus(value: string | null | undefined): RemoteAgentStatus {
  if (!value) return 'idle';
  return KNOWN_STATUSES.has(value) ? (value as RemoteAgentStatus) : 'unknown';
}

function latestActivity(...candidates: Array<number | null | undefined>): number | null {
  const known = candidates.filter((value): value is number => typeof value === 'number');
  return known.length > 0 ? Math.max(...known) : null;
}

/** SQLite's `CURRENT_TIMESTAMP` is UTC without a zone marker; ISO strings carry their own. */
function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/u.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function taskNameFromPrompt(prompt: string): string {
  const firstLine =
    prompt
      .split(/\r?\n/u)
      .find((line) => line.trim())
      ?.trim() ?? '';
  if (!firstLine) return 'New agent';
  if (firstLine.length <= TASK_NAME_LIMIT) return firstLine;
  const cut = firstLine.slice(0, TASK_NAME_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TASK_NAME_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function describeCreateTaskError(error: CreateTaskError): string {
  if ('message' in error && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return error.type === 'project-not-found'
    ? 'That project is no longer open on the host.'
    : `The task could not be created (${error.type}).`;
}

function toRemoteResult(result: { success: true } | Failure): Result<void, RemoteControlError> {
  if (result.success) return ok<void>();
  const notFoundType = result.error.type === 'not-found' || result.error.type === 'not-running';
  const message = result.error.message ?? "The agent's terminal is not running.";
  return err(notFoundType ? notFound(message) : unavailable(message));
}

function notFound(message: string): RemoteControlError {
  return { type: 'not-found', message };
}

function unavailable(message: string): RemoteControlError {
  return { type: 'unavailable', message };
}

function failed(message: string): RemoteControlError {
  return { type: 'failed', message };
}
