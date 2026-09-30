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

/** Resolves a spoken project reference to a project id, defaulting to the only/first project. */
export function resolveProjectId(
  reference: string | undefined,
  preferredId?: string
): string | null {
  const available = [...getProjectManagerStore().projects.values()].filter((project) =>
    asAvailableProject(project)
  );
  if (available.length === 0) return null;
  if (reference?.trim()) {
    const wanted = reference.trim().toLowerCase();
    const match =
      available.find((project) => (project.name ?? '').toLowerCase() === wanted) ??
      available.find((project) => (project.name ?? '').toLowerCase().includes(wanted));
    if (match) return match.id;
  }
  if (preferredId && available.some((project) => project.id === preferredId)) return preferredId;
  return available[0]?.id ?? null;
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
  const agent = metadata.find((candidate) => candidate.id === request.providerId);
  if (!agent) throw new Error(`Unknown agent provider "${request.providerId}".`);
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
        provider: request.providerId,
        title: request.title ?? nextDefaultConversationTitle([]),
        autoApprove: false,
        type: 'pty',
        ...(prompt && canDeliverPrompt ? { initialPrompt: prompt } : {}),
      },
    },
    workspaceConfig,
  };
  await taskManager.createTask(params);
  return { taskId, conversationId, promptDeferred: Boolean(prompt) && !canDeliverPrompt };
}

const START_POLL_MS = 400;
const START_TIMEOUT_MS = 90_000;

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
