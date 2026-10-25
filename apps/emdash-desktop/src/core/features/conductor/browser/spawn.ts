import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  asAvailableProject,
  getProjectManagerStore,
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getAppSettingValueSnapshot,
  prefetchAppSettingsKey,
} from '@core/features/settings/api/browser/app-settings-client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import {
  agentSupportsInitialPromptDelivery,
  type AgentMetadata,
} from '@core/primitives/agents/api';
import { resolveTaskBranchName, type CreateTaskParams } from '@core/primitives/tasks/api';
import { matchProject, projectMatchError } from '../api/project-match';
import { matchInstalledProvider } from '../api/provider-match';
import { buildSpawnWorkspaceConfig } from '../api/spawn-workspace';

export type SpawnRequest = {
  projectId: string;
  providerId: string;
  taskName: string;
  prompt: string;
  /** Pre-generated id, so a spoken name can be claimed for the agent before it exists. */
  conversationId?: string;
  /** Agent window title; defaults to the first roster name. */
  title?: string;
  /** Give the agent its own branch and worktree instead of the project directory. */
  worktree?: boolean;
};

export type SpawnResult = { taskId: string; conversationId: string; promptDeferred: boolean };

let metadataCache: Promise<AgentMetadata[]> | null = null;

export function agentMetadata(): Promise<AgentMetadata[]> {
  metadataCache ??= getAgentsClient()
    .then((client) => client.listMetadata())
    .catch((error: unknown) => {
      metadataCache = null;
      throw error;
    });
  return metadataCache;
}

/**
 * The provider id a loose reference ("Claude", "Claude Code") means among every known provider,
 * installed or not, or the reference itself when none matches (spawnAgentTask then reports it).
 */
export async function resolveProviderId(reference: string): Promise<string> {
  const metadata = await agentMetadata().catch(() => []);
  return matchInstalledProvider(reference, metadata)?.id ?? reference.trim();
}

/** Lowercase kebab-case, ASCII only, for branch names. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'task';
}

function availableProjects() {
  return [...getProjectManagerStore().projects.values()].filter((project) =>
    asAvailableProject(project)
  );
}

/** Open projects by id and name, `first` (by name) leading when it is open. */
export function openProjects(first?: string): { id: string; name: string }[] {
  const open = availableProjects().map((project) => ({
    id: project.id,
    name: project.name ?? project.id,
  }));
  const lead = open.filter((project) => project.name === first);
  return [...lead, ...open.filter((project) => project.name !== first)];
}

/**
 * The project a spoken reference names, or why it names none. With no reference: the preferred
 * project when it is open, else the first. A reference that matches no open project, or several,
 * is an error to put to the developer, never a silent pick.
 */
export function resolveSpokenProject(
  reference: string | undefined,
  preferredId?: string
): { ok: true; id: string } | { ok: false; reason: string } {
  const available = availableProjects();
  if (available.length === 0) return { ok: false, reason: 'No project is open.' };
  if (reference?.trim()) {
    const named = available.map((project) => ({ id: project.id, name: project.name ?? '' }));
    const match = matchProject(reference, named);
    if (match.kind === 'match') return { ok: true, id: match.id };
    return { ok: false, reason: projectMatchError(reference.trim(), match, named) };
  }
  if (preferredId && available.some((project) => project.id === preferredId)) {
    return { ok: true, id: preferredId };
  }
  const first = available[0];
  return first ? { ok: true, id: first.id } : { ok: false, reason: 'No project is open.' };
}

/** The default project: the preferred one when it is open, else the first open project. */
export function resolveProjectId(preferredId?: string): string | null {
  const result = resolveSpokenProject(undefined, preferredId);
  return result.ok ? result.id : null;
}

/**
 * Creates a task with one agent conversation, exactly like the create-task modal. By default the
 * task uses the project directory itself; with `worktree` it gets a fresh worktree on a new branch
 * from the default branch, published only when a push remote exists.
 */
export async function spawnAgentTask(request: SpawnRequest): Promise<SpawnResult> {
  const taskManager = getTaskManagerStore(request.projectId);
  if (!taskManager) throw new Error('That project is not open.');
  const repository = getGitRepositoryStore(request.projectId);

  if (request.worktree) await prefetchAppSettingsKey('project').catch(() => {});
  const workspaceConfig = buildSpawnWorkspaceConfig(request.worktree, {
    repositoryWorkspaceId: projectData(getProjectStore(request.projectId))?.repositoryWorkspaceId,
    fromBranch: repository?.defaultBranchRef,
    pushBranch: repository?.pushRemote != null,
    branchName: () => {
      const projectSettings = getAppSettingValueSnapshot('project');
      return resolveTaskBranchName({
        rawBranch: slugify(request.taskName),
        branchPrefix: projectSettings?.branchPrefix ?? '',
        suffix: Math.random().toString(36).slice(2, 7),
        appendRandomSuffix: projectSettings?.appendRandomBranchSuffix ?? true,
      });
    },
  });

  const metadata = await agentMetadata();
  // Models and speech name providers loosely ("Claude", "Claude Code"); match id or name in any case.
  const agent = matchInstalledProvider(request.providerId, metadata);
  if (!agent) {
    const known = metadata.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown agent provider "${request.providerId}". Known providers: ${known}.`);
  }
  const canDeliverPrompt = agentSupportsInitialPromptDelivery(agent.capabilities);

  const taskId = crypto.randomUUID();
  const conversationId = request.conversationId ?? crypto.randomUUID();
  const prompt = request.prompt.trim();
  const params: CreateTaskParams = {
    id: taskId,
    projectId: request.projectId,
    taskConfig: {
      version: '1',
      name: request.taskName,
      initialConversation: {
        id: conversationId,
        provider: agent.id,
        title: request.title ?? nextDefaultConversationTitle([]),
        autoApprove: false,
        type: 'pty',
        ...(prompt && canDeliverPrompt ? { initialPrompt: prompt } : {}),
      },
    },
    workspaceConfig,
  };
  try {
    await taskManager.createTask(params);
  } catch (error) {
    // A timed-out createTask call can still have created the task in the main process. Starting
    // that task beats reporting a failure and leaving it idle on the canvas, where a retry would
    // add a second one.
    if (!(await taskWasCreated(request.projectId, taskId))) throw error;
  }
  return { taskId, conversationId, promptDeferred: Boolean(prompt) && !canDeliverPrompt };
}

const START_POLL_MS = 400;
const START_TIMEOUT_MS = 90_000;
const CREATED_CHECK_TIMEOUT_MS = 15_000;

/** Whether the task list from the main process shows the task, waiting a little for it to arrive. */
async function taskWasCreated(
  projectId: string,
  taskId: string,
  timeoutMs = CREATED_CHECK_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = getTaskStore(projectId, taskId);
    if (task && task.state !== 'unregistered') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

/**
 * Starts an agent's terminal session without opening its task view: provisions the task workspace
 * when it is asleep, waits for it and the conversation to load, then hydrates the conversation
 * (which launches or resumes the CLI in the task's workspace). Resolves false if it never becomes ready.
 */
export async function startAgentSession(
  projectId: string,
  taskId: string,
  conversationId: string
): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const initial = getTaskStore(projectId, taskId);
  if (initial && initial.state === 'unprovisioned') {
    void getTaskManagerStore(projectId)?.provisionTask(taskId);
  }
  while (Date.now() < deadline) {
    const task = getTaskStore(projectId, taskId);
    const manager = conversationRegistry.get(taskId);
    if (task?.state === 'provisioned' && manager?.conversations.has(conversationId)) {
      if (manager.isSessionActive(conversationId)) return true;
      await manager.hydrateConversation(conversationId);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  return false;
}
