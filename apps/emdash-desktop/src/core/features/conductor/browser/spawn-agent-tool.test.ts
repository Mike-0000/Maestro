import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';

// How the conductor routes a voice spawn_agent: the project directory by default, a separate
// worktree only when the model passes worktree: true for an explicit request.

const mocks = vi.hoisted(() => ({
  spawnAgentTask: vi.fn(async () => ({
    taskId: 'task-1',
    conversationId: 'conv-1',
    promptDeferred: false,
  })),
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: vi.fn(),
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(),
  }),
}));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: vi.fn(),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: vi.fn(() => ({ projects: new Map([['proj', { name: 'Chorus' }]]) })),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(() => 'proj'),
  spawnAgentTask: mocks.spawnAgentTask,
  startAgentSession: vi.fn(async () => false),
}));
vi.mock('./focus-spawned-agent', () => ({ focusSpawnedAgent: vi.fn(() => () => {}) }));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function setup() {
  const canvas = {
    agentEntries: [],
    visibleAgentEntries: [],
    claimSpokenName: () => 'Atlas',
    releaseSpokenName: vi.fn(),
  } as unknown as CanvasStore;
  const voice = {
    muted: false,
    say: vi.fn(),
    announce: vi.fn(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
  } as ConductorVoicePort;
  const store = new ConductorStore(canvas, voice);
  store.status = {
    configured: true,
    jevReady: false,
    settings: DEFAULT_CONDUCTOR_SETTINGS,
  } as unknown as ConductorStatus;
  const requestPending = vi.fn(async (_label: string) => true);
  store['requestPending'] = requestPending;
  return { store, requestPending };
}

const spawnInput = { provider: 'claude', task_name: 'Fix login', prompt: 'Fix the login bug.' };

beforeEach(() => vi.clearAllMocks());

describe('spawn_agent routing', () => {
  it('spawns into the project directory when no worktree was asked for', async () => {
    const { store, requestPending } = setup();
    const outcome = await store['executeTool']('spawn_agent', spawnInput);

    expect(mocks.spawnAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj', providerId: 'claude', worktree: false })
    );
    expect(outcome.content).toContain('in the project directory');
    expect(requestPending.mock.calls[0]![0]).toMatch(/^Start Claude in Chorus on “Fix login”/);
    expect(requestPending.mock.calls[0]![0]).not.toContain('worktree');
  });

  it('spawns into a separate worktree when the request asked for one', async () => {
    const { store, requestPending } = setup();
    const outcome = await store['executeTool']('spawn_agent', { ...spawnInput, worktree: true });

    expect(mocks.spawnAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj', worktree: true })
    );
    expect(outcome.content).toContain('in a new worktree');
    expect(requestPending.mock.calls[0]![0]).toContain('in a new worktree');
  });
});
