import { getAgentsClient } from '@core/features/agents/api/browser/client';
import {
  asAvailableProject,
  getProjectManagerStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getAppSettingValueSnapshot,
  prefetchAppSettingsKey,
} from '@core/features/settings/api/browser/app-settings-client';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import {
  agentSupportsInitialPromptDelivery,
  type AgentMetadata,
} from '@core/primitives/agents/api';
import { resolveTaskBranchName, type CreateTaskParams } from '@core/primitives/tasks/api';

export type SpawnRequest = {
  projectId: string;
  providerId: string;
  taskName: string;
  prompt: string;
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
 * Creates a task in a fresh worktree with one agent conversation, exactly like the create-task
 * modal: branch from the default branch, publish only when a push remote exists.
 */
export async function spawnAgentTask(request: SpawnRequest): Promise<SpawnResult> {
  const taskManager = getTaskManagerStore(request.projectId);
  if (!taskManager) throw new Error('That project is not open.');
  const repository = getGitRepositoryStore(request.projectId);
  const fromBranch = repository?.defaultBranchRef;
  if (!fromBranch)
    throw new Error('The project has no default branch yet (commit something first).');

  const metadata = await agentMetadata();
  const agent = metadata.find((candidate) => candidate.id === request.providerId);
  if (!agent) throw new Error(`Unknown agent provider "${request.providerId}".`);
  const canDeliverPrompt = agentSupportsInitialPromptDelivery(agent.capabilities);

  await prefetchAppSettingsKey('project').catch(() => {});
  const projectSettings = getAppSettingValueSnapshot('project');
  const branchName = resolveTaskBranchName({
    rawBranch: slugify(request.taskName),
    branchPrefix: projectSettings?.branchPrefix ?? '',
    suffix: Math.random().toString(36).slice(2, 7),
    appendRandomSuffix: projectSettings?.appendRandomBranchSuffix ?? true,
  });

  const taskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
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
        title: `${agent.name} (1)`,
        autoApprove: false,
        type: 'pty',
        ...(prompt && canDeliverPrompt ? { initialPrompt: prompt } : {}),
      },
    },
    workspaceConfig: {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName,
        fromBranch,
        pushBranch: repository?.pushRemote != null,
      },
      workspace: { kind: 'new-worktree' },
    },
  };
  await taskManager.createTask(params);
  return { taskId, conversationId, promptDeferred: Boolean(prompt) && !canDeliverPrompt };
}
