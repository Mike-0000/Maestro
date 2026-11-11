import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { Button, Spinner } from '@emdash/ui/react/primitives';
import { AlertTriangle, GitMerge, Play } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { getConductorStore } from '../../contributions/browser/app-stores';
import type { PlannedSubtask, SubtaskState } from '../plan-store';
import { HudCard, HudCardHeader } from './hud-card';

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
    <HudCard label="Conductor plan" className="pt-2.5">
      <HudCardHeader
        glyph={
          <StateGlyph
            state={
              plan.status === 'proposed'
                ? 'needs-you'
                : plan.status === 'running'
                  ? 'working'
                  : 'done'
            }
          />
        }
        title={
          plan.status === 'proposed'
            ? 'Plan to approve'
            : plan.status === 'running'
              ? 'Plan running'
              : 'Plan finished'
        }
        meta={
          plan.status === 'proposed'
            ? `${plan.subtasks.length} agents in ${plan.projectName}`
            : undefined
        }
        onClose={
          plan.status === 'running'
            ? undefined
            : () => (plan.status === 'proposed' ? plans.cancel() : plans.dismiss())
        }
        closeLabel={plan.status === 'proposed' ? 'Discard plan' : 'Dismiss plan'}
      />
      <p className="mt-0.5 pl-6 text-sm text-pretty text-foreground-body">{plan.goal}</p>

      <ol className="mt-3 max-h-64 space-y-0.5 overflow-y-auto">
        {plan.subtasks.map((subtask) => (
          <SubtaskRow key={subtask.title} subtask={subtask} />
        ))}
      </ol>

      {conflicted.length > 0 && (
        <div className="mt-3 flex gap-2 text-xs text-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
          <div className="min-w-0 space-y-0.5">
            {conflicted.map((pair) => (
              <p key={`${pair.a}|${pair.b}`}>
                <span className="font-medium">{pair.a}</span> and{' '}
                <span className="font-medium">{pair.b}</span> would conflict in{' '}
                {pair.files.slice(0, 3).join(', ')}
                {pair.files.length > 3 ? ` and ${pair.files.length - 3} more` : ''}.
              </p>
            ))}
          </div>
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {plan.status === 'proposed' ? (
          <>
            <span className="min-w-0 flex-1 text-xs text-foreground-muted">
              Each agent gets its own worktree and branch. Say “yes” to start.
              {plans.estimatedTokens && (
                <span
                  className="ml-1 text-foreground-passive tabular-nums"
                  title="Rough estimate from Jev's size rating of each subtask; agents bill to their own provider accounts."
                >
                  Est. {formatTokens(plans.estimatedTokens[0])}–
                  {formatTokens(plans.estimatedTokens[1])} agent tokens.
                </span>
              )}
            </span>
            <Button type="button" variant="text" size="xs" onClick={() => plans.cancel()}>
              Discard
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={() => void plans.approve()}>
              <Play aria-hidden className="size-3.5" />
              Start {plan.subtasks.length} agents
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-xs text-foreground-muted">
              {plans.conflictsCheckedAt
                ? conflicted.length === 0
                  ? 'No conflicts predicted between branches.'
                  : `${conflicted.length} conflicting ${conflicted.length === 1 ? 'pair' : 'pairs'}.`
                : 'Conflict radar checks branches as agents work.'}
            </span>
            {awaitingIntegration && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={plans.deliveryStatusRefreshing}
                aria-busy={plans.deliveryStatusRefreshing || undefined}
                onClick={() => void plans.refreshDeliveryReadiness()}
              >
                {plans.deliveryStatusRefreshing ? <Spinner size="sm" /> : <GitMerge aria-hidden />}
                Check handoffs
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={plans.checkingConflicts}
              aria-busy={plans.checkingConflicts || undefined}
              onClick={() => void plans.checkConflicts()}
            >
              {plans.checkingConflicts ? <Spinner size="sm" /> : <GitMerge aria-hidden />}
              Check conflicts
            </Button>
          </>
        )}
      </footer>
    </HudCard>
  );
});

const SubtaskRow = observer(function SubtaskRow({ subtask }: { subtask: PlannedSubtask }) {
  const canvas = getCanvasStore();
  const name = subtask.conversationId ? canvas.spokenName(subtask.conversationId) : null;
  const where =
    subtask.error ??
    (subtask.sequential_after
      ? `After “${subtask.sequential_after}” · ${subtask.owned_paths.join(', ')}`
      : subtask.owned_paths.join(', '));
  return (
    <li className="-mx-2 flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-hover">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <AgentIcon id={subtask.provider} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={!subtask.conversationId}
          onClick={() =>
            subtask.conversationId && canvas.requestFocus(`agent:${subtask.conversationId}`)
          }
          className="block max-w-full truncate rounded-sm text-left text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:underline enabled:hover:decoration-foreground-passive enabled:hover:underline-offset-4"
        >
          {subtask.title}
          {name && <span className="ml-1.5 text-foreground-muted">· {name}</span>}
        </button>
        <p
          className={
            subtask.error
              ? 'truncate text-xs text-foreground-error'
              : 'truncate text-tiny text-foreground-passive'
          }
        >
          {where}
        </p>
      </div>
      {subtask.size && (
        <span
          title="Jev's size estimate"
          className="mt-0.5 shrink-0 text-tiny text-foreground-passive tabular-nums"
        >
          {subtask.size[0]?.toUpperCase()}
        </span>
      )}
      <SubtaskStateLabel state={subtask.state} />
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

const STATE_GLYPHS: Record<SubtaskState, StateGlyphState> = {
  pending: 'idle',
  waiting: 'idle',
  'awaiting-integration': 'needs-you',
  spawning: 'setting-up',
  running: 'working',
  done: 'done',
  failed: 'error',
};

/** A subtask's state in words, with the shared state mark. */
function SubtaskStateLabel({ state }: { state: SubtaskState }) {
  return (
    <span
      className={
        state === 'failed'
          ? 'mt-0.5 flex w-20 shrink-0 items-center gap-1.5 text-xs text-foreground-error'
          : 'mt-0.5 flex w-20 shrink-0 items-center gap-1.5 text-xs text-foreground-muted'
      }
    >
      <StateGlyph state={STATE_GLYPHS[state]} size="sm" />
      {STATE_LABELS[state]}
    </span>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  return `${Math.round(count / 1_000)}k`;
}
