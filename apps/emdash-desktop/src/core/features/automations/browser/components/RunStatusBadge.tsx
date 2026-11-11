import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { Tooltip } from '@emdash/ui/react/primitives';
import type {
  AutomationRun,
  AutomationRunStatus,
} from '@core/features/automations/api/automation-run';
import { formatRunError } from '../automation-run-format';

interface RunStatusBadgeProps {
  status: AutomationRun['status'] | null;
  error: AutomationRun['error'];
}

export type RunStatusPresentation = { glyph: StateGlyphState; words: string };

const RUN_STATUS: Partial<Record<AutomationRunStatus, RunStatusPresentation>> = {
  queued: { glyph: 'idle', words: 'Queued' },
  provisioning_workspace: { glyph: 'setting-up', words: 'Preparing workspace' },
  starting_session: { glyph: 'setting-up', words: 'Starting agent' },
  done: { glyph: 'done', words: 'Agent started' },
  failed: { glyph: 'error', words: 'Failed' },
  skipped: { glyph: 'idle', words: 'Skipped' },
  cancelled: { glyph: 'idle', words: 'Cancelled' },
};

/**
 * A run's status in the one state language (design brief 2.6): the kit glyph plus words. A
 * scheduled run (or no run) has nothing to say yet.
 */
export function runStatusPresentation(
  status: AutomationRunStatus | null
): RunStatusPresentation | null {
  if (!status) return null;
  return RUN_STATUS[status] ?? null;
}

/** The status words, with the failure reason in a tooltip when a run failed. */
export function RunStatusWords({ status, error }: RunStatusBadgeProps) {
  const presentation = runStatusPresentation(status);
  if (!presentation) return null;
  if (status !== 'failed' || !error) return <span>{presentation.words}</span>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span className="cursor-default underline decoration-foreground-passive/50 decoration-dotted underline-offset-2" />
        }
      >
        {presentation.words}
      </Tooltip.Trigger>
      <Tooltip.Content>{formatRunError(error)}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/** Glyph and words together, for places that show a run's status on its own. */
export function RunStatusBadge({ status, error }: RunStatusBadgeProps) {
  const presentation = runStatusPresentation(status);
  if (!presentation) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
      <StateGlyph state={presentation.glyph} size="sm" />
      <RunStatusWords status={status} error={error} />
    </span>
  );
}
