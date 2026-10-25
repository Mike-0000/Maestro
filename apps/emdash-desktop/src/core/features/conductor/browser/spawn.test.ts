import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import {
  developerTyping,
  noteDeveloperInput,
} from '@core/features/terminals/api/browser/pty/developer-typing';
import { spawnAgentTask, startAgentSession } from './spawn';

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTaskStore: vi.fn(),
  listMetadata: vi.fn(async () => [
    { id: 'claude', name: 'Claude Code', capabilities: {} },
    { id: 'codex', name: 'Codex', capabilities: {} },
  ]),
}));

vi.mock('@core/features/agents/api/browser/client', () => ({
  getAgentsClient: async () => ({ listMetadata: mocks.listMetadata }),
}));
vi.mock('@core/features/conversations/api/browser/stores/conversation-registry', () => ({
  conversationRegistry: { get: vi.fn() },
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  asAvailableProject: vi.fn(),
  getProjectManagerStore: vi.fn(() => ({ projects: new Map() })),
  getProjectStore: vi.fn(),
  projectData: vi.fn(() => ({ repositoryWorkspaceId: 'ws-1' })),
}));
vi.mock('@core/features/settings/api/browser/app-settings-client', () => ({
  getAppSettingValueSnapshot: vi.fn(),
  prefetchAppSettingsKey: vi.fn(async () => {}),
}));
vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: vi.fn(() => undefined),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(() => ({ createTask: mocks.createTask })),
  getTaskStore: mocks.getTaskStore,
}));

const request = { projectId: 'proj', taskName: 'Fix login', prompt: '' };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('spawnAgentTask', () => {
  it('creates the task with the provider id a loose name means', async () => {
    mocks.createTask.mockResolvedValue(undefined);
    await spawnAgentTask({ ...request, providerId: 'Claude Code' });
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskConfig: expect.objectContaining({
          initialConversation: expect.objectContaining({ provider: 'claude' }),
        }),
      })
    );
  });

  it('rejects a provider no known one matches, naming the known ones', async () => {
    await expect(spawnAgentTask({ ...request, providerId: 'Gemini' })).rejects.toThrow(
      'Known providers: claude, codex'
    );
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('carries on when a timed-out create did create the task', async () => {
    mocks.createTask.mockRejectedValue(new Error("Wire call 'tasks.createTask' timed out"));
    mocks.getTaskStore.mockReturnValue({ state: 'unprovisioned' });
    const result = await spawnAgentTask({ ...request, providerId: 'claude' });
    expect(result.taskId).toBe(mocks.createTask.mock.calls[0]![0].id);
  });

  it('reports the failure when the task never appears', async () => {
    vi.useFakeTimers();
    mocks.createTask.mockRejectedValue(new Error("Wire call 'tasks.createTask' timed out"));
    mocks.getTaskStore.mockReturnValue({ state: 'unregistered' });
    const spawning = spawnAgentTask({ ...request, providerId: 'claude' });
    const outcome = expect(spawning).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(16_000);
    await outcome;
  });

  it('renames a clashing task and notes a busy agent in the same folder', async () => {
    mocks.createTask.mockResolvedValue(undefined);
    const peers = [
      { name: 'Quartz', projectId: 'proj', status: 'working', inProjectDirectory: true },
    ];
    const result = await spawnAgentTask({
      ...request,
      taskName: 'quartz',
      providerId: 'claude',
      peers,
    });
    expect(result.taskName).toBe('quartz task');
    expect(result.notes).toEqual([
      expect.stringContaining('also the name of agent Quartz'),
      'Quartz is also working in this folder.',
    ]);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskConfig: expect.objectContaining({ name: 'quartz task' }),
      })
    );
  });
});

describe('startAgentSession', () => {
  function manager(active: boolean) {
    return {
      conversations: new Map([['conv-1', {}]]),
      isSessionActive: () => active,
      hydrateConversation: vi.fn(async () => {}),
    };
  }

  it("forgets what was typed into the agent's last session when it starts a new one", async () => {
    mocks.getTaskStore.mockReturnValue({ state: 'provisioned' });
    vi.mocked(conversationRegistry.get).mockReturnValue(manager(false) as never);
    noteDeveloperInput('proj:task-1:conv-1', 'half a sentence');

    await expect(startAgentSession('proj', 'task-1', 'conv-1')).resolves.toBe(true);
    expect(developerTyping('conv-1')).toBeNull();
  });

  it('keeps it for a session that is already running', async () => {
    mocks.getTaskStore.mockReturnValue({ state: 'provisioned' });
    vi.mocked(conversationRegistry.get).mockReturnValue(manager(true) as never);
    noteDeveloperInput('proj:task-1:conv-1', 'half a sentence');

    await expect(startAgentSession('proj', 'task-1', 'conv-1')).resolves.toBe(true);
    expect(developerTyping('conv-1')?.unsentText).toBe(true);
  });
});
