import { describe, expect, it, vi } from 'vitest';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { PlanStore, type Plan, type PlannedSubtask } from './plan-store';

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
