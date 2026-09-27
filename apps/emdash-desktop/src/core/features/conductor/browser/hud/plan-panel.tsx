import { CheckCircle2, CircleDashed, GitMerge, Loader2, Play, X, XCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { cn } from '@core/primitives/styling/browser/cn';
import { getConductorStore } from '../../contributions/browser/app-stores';
import type { PlannedSubtask, SubtaskState } from '../plan-store';

/** The active plan: approval before it starts, then live progress and the conflict radar. */
export const PlanPanel = observer(function PlanPanel() {
  const plans = getConductorStore().plans;
  const plan = plans.plan;
  if (!plan || plan.status === 'cancelled') return null;
  const conflicted = plans.conflicts?.pairs.filter((pair) => pair.conflicted) ?? [];
  const awaitingIntegration = plan.subtasks.some(
    (subtask) => subtask.state === 'awaiting-integration'
  );

  return (
    <section
      aria-label="Conductor plan"
      className="pointer-events-auto w-full max-w-[560px] rounded-2xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur"
    >
      <header className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium tracking-wide text-foreground-muted uppercase">
            {plan.status === 'proposed'
              ? `Plan · ${plan.subtasks.length} agents in ${plan.projectName}`
              : plan.status === 'running'
                ? 'Plan running'
                : 'Plan finished'}
          </p>
          <p className="text-sm font-medium text-foreground">{plan.goal}</p>
        </div>
        {plan.status !== 'running' && (
          <button
            type="button"
            aria-label={plan.status === 'proposed' ? 'Discard plan' : 'Dismiss plan'}
            onClick={() => (plan.status === 'proposed' ? plans.cancel() : plans.dismiss())}
            className="flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-secondary hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>

      <ol className="max-h-64 space-y-1.5 overflow-y-auto">
        {plan.subtasks.map((subtask) => (
          <SubtaskRow key={subtask.title} subtask={subtask} />
        ))}
      </ol>

      {conflicted.length > 0 && (
        <div className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs text-foreground">
          {conflicted.map((pair) => (
            <p key={`${pair.a}|${pair.b}`}>
              <strong>{pair.a}</strong> and <strong>{pair.b}</strong> would conflict in{' '}
              {pair.files.slice(0, 3).join(', ')}
              {pair.files.length > 3 ? ` and ${pair.files.length - 3} more` : ''}.
            </p>
          ))}
        </div>
      )}

      <footer className="mt-3 flex items-center gap-2">
        {plan.status === 'proposed' ? (
          <>
            <span className="flex-1 text-xs text-foreground-muted">
              Each agent gets its own worktree and branch. Say “yes” to start.
              {plans.estimatedTokens && (
                <span
                  className="ml-1 tabular-nums"
                  title="Rough estimate from Jev's size rating of each subtask; agents bill to their own provider accounts."
                >
                  Est. {formatTokens(plans.estimatedTokens[0])}–
                  {formatTokens(plans.estimatedTokens[1])} agent tokens.
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => plans.cancel()}
              className="rounded-md px-2.5 py-1.5 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void plans.approve()}
              className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            >
              <Play className="size-3.5" />
              Start {plan.subtasks.length} agents
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 text-xs text-foreground-muted">
              {plans.conflictsCheckedAt
                ? conflicted.length === 0
                  ? 'No conflicts predicted between branches.'
                  : `${conflicted.length} conflicting ${conflicted.length === 1 ? 'pair' : 'pairs'}.`
                : 'Conflict radar checks branches as agents work.'}
            </span>
            {awaitingIntegration && (
              <button
                type="button"
                disabled={plans.deliveryStatusRefreshing}
                onClick={() => void plans.refreshDeliveryReadiness()}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-background-secondary disabled:opacity-50"
              >
                {plans.deliveryStatusRefreshing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitMerge className="size-3.5" />
                )}
                Check handoffs
              </button>
            )}
            <button
              type="button"
              disabled={plans.checkingConflicts}
              onClick={() => void plans.checkConflicts()}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-background-secondary disabled:opacity-50"
            >
              {plans.checkingConflicts ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <GitMerge className="size-3.5" />
              )}
              Check conflicts
            </button>
          </>
        )}
      </footer>
    </section>
  );
});

const SubtaskRow = observer(function SubtaskRow({ subtask }: { subtask: PlannedSubtask }) {
  const canvas = getCanvasStore();
  const name = subtask.conversationId ? canvas.spokenName(subtask.conversationId) : null;
  return (
    <li className="flex items-start gap-2 rounded-lg bg-background-secondary/60 px-2 py-1.5">
      <span className="mt-0.5">
        <AgentIcon id={subtask.provider} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={!subtask.conversationId}
          onClick={() =>
            subtask.conversationId && canvas.requestFocus(`agent:${subtask.conversationId}`)
          }
          className="block max-w-full truncate text-left text-xs font-medium text-foreground enabled:hover:underline"
        >
          {subtask.title}
          {name && <span className="ml-1.5 font-normal text-foreground-muted">· {name}</span>}
        </button>
        <p className="truncate text-[11px] text-foreground-muted">
          {subtask.error ??
            (subtask.sequential_after
              ? `After “${subtask.sequential_after}” · ${subtask.owned_paths.join(', ')}`
              : subtask.owned_paths.join(', '))}
        </p>
      </div>
      {subtask.size && (
        <span
          title="Jev's size estimate"
          className="shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted uppercase"
        >
          {subtask.size[0]}
        </span>
      )}
      <StateChip state={subtask.state} />
    </li>
  );
});

const STATE_LABELS: Record<SubtaskState, string> = {
  pending: 'Ready',
  waiting: 'Waiting',
  'awaiting-integration': 'Handoff',
  spawning: 'Starting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

function StateChip({ state }: { state: SubtaskState }) {
  const icon =
    state === 'done' ? (
      <CheckCircle2 className="size-3" />
    ) : state === 'failed' ? (
      <XCircle className="size-3" />
    ) : state === 'running' || state === 'spawning' ? (
      <Loader2 className="size-3 animate-spin" />
    ) : (
      <CircleDashed className="size-3" />
    );
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        state === 'done' && 'bg-green-500/15 text-green-700 dark:text-green-300',
        state === 'failed' && 'bg-red-500/15 text-red-700 dark:text-red-300',
        (state === 'running' || state === 'spawning') &&
          'bg-blue-500/15 text-blue-700 dark:text-blue-300',
        (state === 'pending' || state === 'waiting') && 'bg-foreground/5 text-foreground-muted'
      )}
    >
      {icon}
      {STATE_LABELS[state]}
    </span>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  return `${Math.round(count / 1_000)}k`;
}
