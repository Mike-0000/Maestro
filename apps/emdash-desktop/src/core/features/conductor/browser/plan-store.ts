import { makeAutoObservable, reaction, runInAction } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../api/browser/client';
import type { ConflictReport } from '../api/contract';
import { findPlanOverlaps, scopedPrompt, type PlanInput, type PlanSubtask } from '../api/plan';
import { deliverPromptWhenReady } from './deferred-prompt';
import type { InstalledProvider } from './roster';
import { entryForConversation } from './roster';
import { resolveProjectId, spawnAgentTask, startAgentSession } from './spawn';

export type SubtaskState = 'pending' | 'waiting' | 'spawning' | 'running' | 'done' | 'failed';

export type PlannedSubtask = PlanSubtask & {
  state: SubtaskState;
  taskId?: string;
  conversationId?: string;
  error?: string;
};

export type PlanStatus = 'proposed' | 'running' | 'done' | 'cancelled';

export type Plan = {
  id: string;
  goal: string;
  projectId: string;
  projectName: string;
  subtasks: PlannedSubtask[];
  status: PlanStatus;
  createdAt: number;
};

export type ProposeResult = { ok: true; plan: Plan } | { ok: false; reason: string };

export type PlanEvents = {
  /** Spoken/visible notices, e.g. "Plan finished" or "Two subtasks may conflict". */
  notify(text: string): void;
};

/** How often the conflict radar re-checks running plan branches. */
const RADAR_INTERVAL_MS = 90_000;

/**
 * The conductor's active plan: a goal split into parallel agents, each in its own worktree.
 * Plans only start after approval (unless auto-approve is on); subtasks with `sequential_after`
 * start when their predecessor finishes; a conflict radar predicts merge conflicts between
 * running branches.
 */
export class PlanStore {
  plan: Plan | null = null;
  conflicts: ConflictReport | null = null;
  conflictsCheckedAt: number | null = null;
  checkingConflicts = false;
  private radarTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly canvas: CanvasStore,
    private readonly events: PlanEvents
  ) {
    makeAutoObservable<PlanStore, 'canvas' | 'events' | 'radarTimer' | 'disposers'>(this, {
      canvas: false,
      events: false,
      radarTimer: false,
      disposers: false,
    });
    // Advance subtasks as their agents finish.
    this.disposers.push(
      reaction(
        () =>
          this.plan?.subtasks.map((subtask) =>
            subtask.conversationId
              ? (entryForConversation(this.canvas, subtask.conversationId)?.status ?? 'unknown')
              : subtask.state
          ) ?? [],
        () => this.advance()
      )
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.stopRadar();
  }

  get awaitingApproval(): boolean {
    return this.plan?.status === 'proposed';
  }

  get runningSubtasks(): PlannedSubtask[] {
    return this.plan?.subtasks.filter((subtask) => subtask.state === 'running') ?? [];
  }

  /** One line for the conductor's context block. */
  get contextLine(): string | null {
    const plan = this.plan;
    if (!plan || plan.status === 'cancelled') return null;
    const parts = plan.subtasks.map((subtask) => `${subtask.title} (${subtask.state})`);
    return `Current plan (${plan.status}) for "${plan.goal}": ${parts.join('; ')}`;
  }

  /** Validates and stores a proposed plan. Returns a reason the model can act on when invalid. */
  propose(
    input: PlanInput,
    options: {
      providers: readonly InstalledProvider[];
      maxAgents: number;
      preferredProjectId?: string;
    }
  ): ProposeResult {
    if (this.plan?.status === 'running') {
      return { ok: false, reason: 'A plan is already running. Finish or cancel it first.' };
    }
    if (input.subtasks.length > options.maxAgents) {
      return {
        ok: false,
        reason: `Plans are limited to ${options.maxAgents} agents; merge subtasks and propose again.`,
      };
    }
    const projectId = resolveProjectId(input.project, options.preferredProjectId);
    if (!projectId) return { ok: false, reason: 'No project is open. Ask the user to open one.' };
    const titles = new Set(input.subtasks.map((subtask) => subtask.title));
    if (titles.size !== input.subtasks.length) {
      return { ok: false, reason: 'Subtask titles must be unique.' };
    }
    const installed = new Set(options.providers.map((provider) => provider.id));
    for (const subtask of input.subtasks) {
      if (installed.size > 0 && !installed.has(subtask.provider)) {
        return {
          ok: false,
          reason: `Provider "${subtask.provider}" is not installed. Use one of: ${[...installed].join(', ')}.`,
        };
      }
      if (subtask.sequential_after && !titles.has(subtask.sequential_after)) {
        return {
          ok: false,
          reason: `"${subtask.title}" runs after "${subtask.sequential_after}", which is not in the plan.`,
        };
      }
      if (subtask.sequential_after === subtask.title) {
        return { ok: false, reason: `"${subtask.title}" cannot run after itself.` };
      }
    }
    if (hasCycle(input.subtasks)) {
      return { ok: false, reason: 'The sequential_after links form a cycle.' };
    }
    const overlaps = findPlanOverlaps(input.subtasks);
    if (overlaps.length > 0) {
      const detail = overlaps
        .map((overlap) => `"${overlap.a}" (${overlap.pathA}) and "${overlap.b}" (${overlap.pathB})`)
        .join('; ');
      return {
        ok: false,
        reason: `Parallel subtasks would edit the same files: ${detail}. Split ownership differently or make one sequential_after the other.`,
      };
    }
    const projectName =
      this.canvas.projectOptions.find((project) => project.id === projectId)?.name ?? 'project';
    const plan: Plan = {
      id: crypto.randomUUID(),
      goal: input.goal,
      projectId,
      projectName,
      subtasks: input.subtasks.map((subtask) => ({
        ...subtask,
        state: subtask.sequential_after ? 'waiting' : 'pending',
      })),
      status: 'proposed',
      createdAt: Date.now(),
    };
    this.plan = plan;
    this.conflicts = null;
    this.conflictsCheckedAt = null;
    return { ok: true, plan };
  }

  /** Starts every subtask that has no predecessor. */
  async approve(): Promise<void> {
    const plan = this.plan;
    if (!plan || plan.status !== 'proposed') return;
    plan.status = 'running';
    for (const subtask of plan.subtasks) {
      if (subtask.state === 'pending') await this.spawn(subtask);
    }
    this.startRadar();
  }

  cancel(): void {
    const plan = this.plan;
    if (!plan) return;
    if (plan.status === 'proposed') {
      this.plan = null;
    } else {
      plan.status = 'cancelled';
    }
    this.stopRadar();
  }

  dismiss(): void {
    if (this.plan?.status === 'running') return;
    this.plan = null;
    this.conflicts = null;
    this.stopRadar();
  }

  private async spawn(subtask: PlannedSubtask): Promise<void> {
    const plan = this.plan;
    if (!plan || plan.status !== 'running') return;
    subtask.state = 'spawning';
    try {
      const prompt = scopedPrompt(subtask, plan.goal);
      const result = await spawnAgentTask({
        projectId: plan.projectId,
        providerId: subtask.provider,
        taskName: subtask.title,
        prompt,
      });
      runInAction(() => {
        subtask.taskId = result.taskId;
        subtask.conversationId = result.conversationId;
        subtask.state = 'running';
      });
      const started = await startAgentSession(plan.projectId, result.taskId, result.conversationId);
      if (!started) throw new Error('The agent did not start in time.');
      if (result.promptDeferred) {
        void deliverPromptWhenReady(this.canvas, result.conversationId, prompt);
      }
    } catch (error) {
      log.warn('conductor: plan subtask failed to start', { error, title: subtask.title });
      runInAction(() => {
        subtask.state = 'failed';
        subtask.error = error instanceof Error ? error.message : String(error);
      });
      this.events.notify(`${subtask.title} failed to start.`);
    }
  }

  /** Marks finished subtasks done and starts their dependents. */
  private advance(): void {
    const plan = this.plan;
    if (!plan || plan.status !== 'running') return;
    for (const subtask of plan.subtasks) {
      if (subtask.state !== 'running' || !subtask.conversationId) continue;
      const entry = entryForConversation(this.canvas, subtask.conversationId);
      if (entry?.status === 'completed') subtask.state = 'done';
    }
    for (const subtask of plan.subtasks) {
      if (subtask.state !== 'waiting') continue;
      const predecessor = plan.subtasks.find((other) => other.title === subtask.sequential_after);
      if (predecessor?.state === 'done') {
        subtask.state = 'pending';
        void this.spawn(subtask);
      } else if (predecessor?.state === 'failed') {
        subtask.state = 'failed';
        subtask.error = `Blocked: "${predecessor.title}" failed.`;
      }
    }
    if (plan.subtasks.every((subtask) => subtask.state === 'done' || subtask.state === 'failed')) {
      plan.status = 'done';
      this.stopRadar();
      const failed = plan.subtasks.filter((subtask) => subtask.state === 'failed').length;
      this.events.notify(
        failed === 0
          ? `The plan is done. All ${plan.subtasks.length} agents finished.`
          : `The plan finished with ${failed} failed ${failed === 1 ? 'subtask' : 'subtasks'}.`
      );
      void this.checkConflicts();
    }
  }

  // ── Conflict radar ─────────────────────────────────────────────────────────

  private startRadar(): void {
    this.stopRadar();
    this.radarTimer = setInterval(() => void this.checkConflicts(), RADAR_INTERVAL_MS);
  }

  private stopRadar(): void {
    if (this.radarTimer) clearInterval(this.radarTimer);
    this.radarTimer = null;
  }

  /** Predicts conflicts between the plan's branches. Reports newly conflicting pairs. */
  async checkConflicts(): Promise<ConflictReport | null> {
    const plan = this.plan;
    if (!plan || this.checkingConflicts) return this.conflicts;
    const worktrees = plan.subtasks.flatMap((subtask) => {
      if (!subtask.taskId) return [];
      const path = getTaskStore(plan.projectId, subtask.taskId)?.workspacePath;
      return path ? [{ label: subtask.title, path }] : [];
    });
    if (worktrees.length < 2) return null;
    this.checkingConflicts = true;
    try {
      const result = await (await getConductorClient()).checkConflicts({ worktrees });
      const previous = new Set(
        this.conflicts?.pairs.filter((pair) => pair.conflicted).map((pair) => `${pair.a}|${pair.b}`)
      );
      runInAction(() => {
        this.checkingConflicts = false;
        if (!result.success) return;
        this.conflicts = result.data;
        this.conflictsCheckedAt = Date.now();
      });
      if (!result.success) return null;
      const fresh = result.data.pairs.filter(
        (pair) => pair.conflicted && !previous.has(`${pair.a}|${pair.b}`)
      );
      const first = fresh[0];
      if (first) {
        this.events.notify(
          `Heads up: ${first.a} and ${first.b} would conflict in ${first.files.length} ${first.files.length === 1 ? 'file' : 'files'}.`
        );
      }
      return result.data;
    } catch (error) {
      log.warn('conductor: conflict check failed', { error });
      runInAction(() => (this.checkingConflicts = false));
      return null;
    }
  }
}

function hasCycle(subtasks: readonly PlanSubtask[]): boolean {
  const next = new Map(subtasks.map((subtask) => [subtask.title, subtask.sequential_after]));
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = next.get(current);
    }
  }
  return false;
}
