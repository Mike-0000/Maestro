import { makeAutoObservable, reaction, runInAction } from 'mobx';
import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import { getLocalUpdatesClient } from '@core/features/local-updates/api/browser/client';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../api/browser/client';
import type { ConflictReport } from '../api/contract';
import { SIZE_TOKEN_RANGE, type SubtaskSize } from '../api/jev';
import { findPlanOverlaps, scopedPrompt, type PlanInput, type PlanSubtask } from '../api/plan';
import { matchInstalledProvider, type InstalledProvider } from '../api/provider-match';
import { CodexNotStartedError, DeliveryLeftUnsentError } from './agent-io';
import { deliverPromptWhenReady } from './deferred-prompt';
import { entryForConversation } from './roster';
import { resolveSpokenProject, spawnAgentTask, startAgentSession } from './spawn';

export type SubtaskState =
  | 'pending'
  | 'waiting'
  | 'awaiting-integration'
  | 'spawning'
  | 'running'
  | 'done'
  | 'failed';

export type PlannedSubtask = PlanSubtask & {
  state: SubtaskState;
  /** Jev's size estimate, when available (drives the rough cost readout). */
  size?: SubtaskSize;
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
  /** Region the plan's agents gather in on the canvas (when grouping plan agents is on). */
  regionName?: string;
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
  private checkingDelivery = false;

  constructor(
    private readonly canvas: CanvasStore,
    private readonly events: PlanEvents
  ) {
    makeAutoObservable<
      PlanStore,
      'canvas' | 'events' | 'radarTimer' | 'disposers' | 'checkingDelivery'
    >(this, {
      canvas: false,
      events: false,
      radarTimer: false,
      disposers: false,
      checkingDelivery: false,
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

  get deliveryStatusRefreshing(): boolean {
    return this.checkingDelivery;
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
    const project = resolveSpokenProject(input.project, options.preferredProjectId);
    if (!project.ok) {
      return {
        ok: false,
        reason:
          project.reason === 'No project is open.'
            ? 'No project is open. Ask the user to open one.'
            : project.reason,
      };
    }
    const projectId = project.id;
    const titles = new Set(input.subtasks.map((subtask) => subtask.title));
    if (titles.size !== input.subtasks.length) {
      return { ok: false, reason: 'Subtask titles must be unique.' };
    }
    const installed = options.providers;
    for (const subtask of input.subtasks) {
      if (installed.length > 0 && !matchInstalledProvider(subtask.provider, installed)) {
        return {
          ok: false,
          reason: `Provider "${subtask.provider}" is not installed. Use one of: ${installed.map((provider) => provider.id).join(', ')}.`,
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
        provider: matchInstalledProvider(subtask.provider, installed)?.id ?? subtask.provider,
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
    if (this.canvas.layoutSettings.groupPlanAgents && plan.subtasks.length > 1) {
      plan.regionName = this.canvas.reserveRegion([], planRegionName(plan.goal));
    }
    for (const subtask of plan.subtasks) {
      if (subtask.state === 'pending') await this.spawn(subtask);
    }
    this.startRadar();
  }

  /**
   * How the plan's start went, for the model that started it: which agents are running, and which
   * failed and why. A plan once reported "started" while every agent in it had failed.
   */
  startSummary(): { text: string; allFailed: boolean } {
    const plan = this.plan;
    if (!plan) return { text: 'There is no plan.', allFailed: true };
    const failed = plan.subtasks.filter((subtask) => subtask.state === 'failed');
    const starting = plan.subtasks.filter(
      (subtask) => subtask.state === 'pending' || subtask.state === 'spawning'
    );
    const waiting = plan.subtasks.filter((subtask) => subtask.state === 'waiting');
    const running = plan.subtasks.length - failed.length - starting.length - waiting.length;
    const parts = [
      `Plan in ${plan.projectName}: ${running} of ${plan.subtasks.length} agents started`,
    ];
    if (starting.length > 0) parts.push(`${starting.length} still starting`);
    if (waiting.length > 0) parts.push(`${waiting.length} waiting for an earlier subtask`);
    let text = `${parts.join(', ')}.`;
    if (failed.length > 0) {
      text += ` Failed to start: ${failed
        .map((subtask) => `"${subtask.title}" (${subtask.error ?? 'unknown error'})`)
        .join('; ')}. Tell the developer.`;
    }
    return { text, allFailed: failed.length === plan.subtasks.length };
  }

  /** Attaches Jev's per-subtask size estimates to the proposed plan. */
  setSizes(sizes: readonly (SubtaskSize | null)[]): void {
    const plan = this.plan;
    if (!plan) return;
    plan.subtasks.forEach((subtask, index) => {
      const size = sizes[index];
      if (size) subtask.size = size;
    });
  }

  /** Rough total agent tokens for the plan, from Jev sizes; null when unsized. */
  get estimatedTokens(): [number, number] | null {
    const subtasks = this.plan?.subtasks ?? [];
    if (subtasks.length === 0 || subtasks.some((subtask) => !subtask.size)) return null;
    return subtasks.reduce<[number, number]>(
      (total, subtask) => {
        const range = SIZE_TOKEN_RANGE[subtask.size ?? 'medium'];
        return [total[0] + range[0], total[1] + range[1]];
      },
      [0, 0]
    );
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
      const conversationId = crypto.randomUUID();
      const name = this.canvas.claimSpokenName(conversationId);
      const result = await spawnAgentTask({
        projectId: plan.projectId,
        providerId: subtask.provider,
        taskName: subtask.title,
        prompt,
        conversationId,
        title: name,
        // Parallel subtasks need isolation: the conflict radar compares their branches.
        worktree: true,
      }).catch((error: unknown) => {
        this.canvas.releaseSpokenName(conversationId);
        throw error;
      });
      if (plan.regionName) this.canvas.joinRegionOnArrival(result.conversationId, plan.regionName);
      runInAction(() => {
        subtask.taskId = result.taskId;
        subtask.conversationId = result.conversationId;
        subtask.state = 'running';
      });
      const started = await startAgentSession(plan.projectId, result.taskId, result.conversationId);
      if (!started) throw new Error('The agent did not start in time.');
      if (result.promptDeferred) {
        void deliverPromptWhenReady(this.canvas, result.conversationId, prompt).catch(
          (error: unknown) => this.briefNotDelivered(subtask, name, error)
        );
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

  /**
   * Says why a started subtask's agent did not get its brief. A brief Codex did not take is
   * waiting in its input, so the developer is told to press Enter there, not to send it again.
   */
  private briefNotDelivered(subtask: PlannedSubtask, name: string, error: unknown): void {
    log.warn('conductor: plan subtask brief not delivered', { error, title: subtask.title });
    this.events.notify(
      error instanceof CodexNotStartedError
        ? `Pasted the "${subtask.title}" brief into ${name}, but Codex didn't start; press Enter in its window.`
        : error instanceof DeliveryLeftUnsentError
          ? `Left the "${subtask.title}" brief in ${name}'s input because you were typing there; press Enter when ready.`
          : `${name} did not get its "${subtask.title}" brief: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  /** Marks finished subtasks done and starts their dependents. */
  private advance(): void {
    const plan = this.plan;
    if (!plan || plan.status !== 'running') return;
    for (const subtask of plan.subtasks) {
      if (subtask.state !== 'running' || !subtask.conversationId) continue;
      const entry = entryForConversation(this.canvas, subtask.conversationId);
      if (entry?.status !== 'completed') continue;
      const hasDependents = plan.subtasks.some((other) => other.sequential_after === subtask.title);
      if (hasDependents) {
        subtask.state = 'awaiting-integration';
        subtask.error = 'Submit and promote this task before its dependent can start.';
        void this.refreshDeliveryReadiness();
      } else {
        subtask.state = 'done';
      }
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

  async refreshDeliveryReadiness(): Promise<void> {
    const plan = this.plan;
    if (!plan || plan.status !== 'running' || this.checkingDelivery) return;
    const waiting = plan.subtasks.filter((subtask) => subtask.state === 'awaiting-integration');
    if (waiting.length === 0) return;

    this.checkingDelivery = true;
    try {
      const status = await (await getLocalUpdatesClient()).status({ projectId: plan.projectId });
      runInAction(() => {
        if (this.plan !== plan || plan.status !== 'running') return;
        for (const subtask of waiting) {
          const task = subtask.taskId
            ? status.success
              ? status.data.tasks.find((candidate) => candidate.taskId === subtask.taskId)
              : undefined
            : undefined;
          if (task?.state === 'integrated') {
            subtask.state = 'done';
            delete subtask.error;
          } else {
            const detail = status.success
              ? task
                ? `current delivery state: ${task.state}`
                : 'this task is not enrolled in the project coordinator'
              : status.error.message;
            subtask.error = `Waiting for this task to be submitted and promoted to chorus/main (${detail}).`;
          }
        }
      });
      this.advance();
    } catch (error) {
      runInAction(() => {
        for (const subtask of waiting) {
          subtask.error = `Waiting for project delivery status: ${error instanceof Error ? error.message : String(error)}`;
        }
      });
    } finally {
      runInAction(() => (this.checkingDelivery = false));
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

/** A short region name from a plan goal: its first few words ("Checkout redesign"). */
export function planRegionName(goal: string): string {
  const words = goal
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words.join(' ').slice(0, 32).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Plan';
}
