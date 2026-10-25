import { describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { deliverPromptWhenReady } from './deferred-prompt';
import { PlanStore, type Plan, type PlannedSubtask } from './plan-store';
import { spawnAgentTask, startAgentSession } from './spawn';

const mocks = vi.hoisted(() => ({
  CodexNotStartedError: class extends Error {
    readonly pasted = true;
  },
  DeliveryLeftUnsentError: class extends Error {
    readonly pasted = true;
  },
}));

vi.mock('@core/features/local-updates/api/browser/client', () => ({
  getLocalUpdatesClient: vi.fn(),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: vi.fn(),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../api/browser/client', () => ({ getConductorClient: vi.fn() }));
vi.mock('./agent-io', () => ({
  CodexNotStartedError: mocks.CodexNotStartedError,
  DeliveryLeftUnsentError: mocks.DeliveryLeftUnsentError,
}));
vi.mock('./deferred-prompt', () => ({ deliverPromptWhenReady: vi.fn() }));
vi.mock('./roster', () => ({ entryForConversation: vi.fn() }));
vi.mock('./spawn', () => ({
  resolveSpokenProject: vi.fn(),
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(),
}));

function subtask(title: string, state: PlannedSubtask['state'], error?: string): PlannedSubtask {
  return {
    title,
    provider: 'claude',
    prompt: `Do ${title}.`,
    state,
    ...(error ? { error } : {}),
  } as PlannedSubtask;
}

function storeWith(subtasks: PlannedSubtask[]): PlanStore {
  const store = new PlanStore({} as CanvasStore, { notify: vi.fn() });
  const plan: Plan = {
    id: 'plan-1',
    goal: 'Replayable modes',
    projectId: 'proj',
    projectName: 'ACE COMBAT 8',
    subtasks,
    status: 'running',
    createdAt: 0,
  };
  store.plan = plan;
  return store;
}

describe('PlanStore.startSummary', () => {
  it('says which agents started and which failed, with why', () => {
    const summary = storeWith([
      subtask('Dogfight', 'running'),
      subtask(
        'Endless',
        'failed',
        'The project has no default branch yet (commit something first).'
      ),
      subtask('Staged', 'waiting'),
    ]).startSummary();
    expect(summary.allFailed).toBe(false);
    expect(summary.text).toBe(
      'Plan in ACE COMBAT 8: 1 of 3 agents started, 1 waiting for an earlier subtask. Failed to start: "Endless" (The project has no default branch yet (commit something first).). Tell the developer.'
    );
  });

  it('never calls a plan started when every agent failed', () => {
    const summary = storeWith([
      subtask('Dogfight', 'failed', 'No default branch.'),
      subtask('Endless', 'failed', 'No default branch.'),
    ]).startSummary();
    expect(summary.allFailed).toBe(true);
    expect(summary.text).toContain('0 of 2 agents started');
  });
});

describe('PlanStore delivering a deferred brief', () => {
  function startingStore() {
    const notify = vi.fn();
    const canvas = {
      claimSpokenName: () => 'Xenon',
      releaseSpokenName: vi.fn(),
      joinRegionOnArrival: vi.fn(),
    } as unknown as CanvasStore;
    const store = new PlanStore(canvas, { notify });
    const task = { ...subtask('Endless', 'pending'), owned_paths: ['src/modes/'] };
    store.plan = {
      id: 'plan-1',
      goal: 'Replayable modes',
      projectId: 'proj',
      projectName: 'ACE COMBAT 8',
      subtasks: [task],
      status: 'running',
      createdAt: 0,
    };
    vi.mocked(spawnAgentTask).mockResolvedValue({
      taskId: 'task-1',
      conversationId: 'conv-1',
      promptDeferred: true,
    } as never);
    vi.mocked(startAgentSession).mockResolvedValue(true);
    return { store, task, notify };
  }

  const settle = async () => {
    for (let round = 0; round < 10; round++) await Promise.resolve();
  };

  it('announces a brief Codex did not take, by agent name, instead of leaving it unhandled', async () => {
    const { store, task, notify } = startingStore();
    vi.mocked(deliverPromptWhenReady).mockRejectedValue(
      new mocks.CodexNotStartedError("Pasted into Endless, but Codex didn't start")
    );

    await store['spawn'](task);
    await settle();

    expect(task.error).toBeUndefined();
    expect(task.state).toBe('running');
    expect(notify).toHaveBeenCalledWith(
      `Pasted the "Endless" brief into Xenon, but Codex didn't start; press Enter in its window.`
    );
  });

  it('announces any other failure to deliver the brief as it is', async () => {
    const { store, task, notify } = startingStore();
    vi.mocked(deliverPromptWhenReady).mockRejectedValue(
      new Error('Endless has text you have not sent in its input.')
    );

    await store['spawn'](task);
    await settle();

    expect(notify).toHaveBeenCalledWith(
      'Xenon did not get its "Endless" brief: Endless has text you have not sent in its input.'
    );
  });

  it('says a brief was left in the input while the developer typed there', async () => {
    const { store, task, notify } = startingStore();
    vi.mocked(deliverPromptWhenReady).mockRejectedValue(
      new mocks.DeliveryLeftUnsentError("Left in Endless's input")
    );

    await store['spawn'](task);
    await settle();

    expect(notify).toHaveBeenCalledWith(
      `Left the "Endless" brief in Xenon's input because you were typing there; press Enter when ready.`
    );
  });
});
