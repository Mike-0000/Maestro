import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { MetaLine } from '@emdash/ui/react/patterns';
import { AbsoluteTime, RelativeTime, Switch } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import {
  useLatestAutomationRun,
  useScheduledAutomationRun,
  useAutomationTargetAvailability,
} from '@core/features/automations/browser/use-automations';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import {
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  getTaskIdForAutomationRun,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import type { Automation } from '@core/primitives/automations/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { agentRunState } from './agent-state';
import { automationScheduleLabel } from './automation-schedule';
import { runStatusPresentation } from './RunStatusBadge';

interface AutomationRowProps {
  automation: Automation;
  onToggleEnabled?: (enabled: boolean) => void;
}

type RowState = { glyph?: StateGlyphState; words: ReactNode; tone?: 'muted' | 'warning' };

/**
 * Row content for the automations list, read like the project task list: the name, then one
 * caption line with the state (glyph and words), the schedule and the project; the next run and
 * the on / paused switch on the right. The CollectionView shell owns the row click.
 */
export const AutomationRow = observer(function AutomationRow({
  automation,
  onToggleEnabled,
}: AutomationRowProps) {
  const availability = useAutomationTargetAvailability(automation.projectId);
  const runtimeAvailable = availability.data?.available === true;
  const latestRunQuery = useLatestAutomationRun(
    automation.projectId!,
    automation.id,
    runtimeAvailable
  );
  const scheduledRunQuery = useScheduledAutomationRun(
    automation.projectId!,
    automation.id,
    runtimeAvailable
  );

  const run = latestRunQuery.data ?? null;
  const scheduledAt = runtimeAvailable ? (scheduledRunQuery.data?.scheduledAt ?? null) : null;

  const projectId = automation.projectId ?? null;
  const taskId = run && projectId ? getTaskIdForAutomationRun(projectId, run.id) : null;
  const taskStore = taskId && projectId ? getTaskStore(projectId, taskId) : undefined;
  const agentState = agentRunState(taskStore ? taskAgentStatus(taskStore) : null);

  // One state, most pressing first: the runtime is gone, the agent a run started is waiting or
  // at work, the automation is paused, then what its last run did.
  const state: RowState = (() => {
    if (!runtimeAvailable) {
      return {
        words: availability.data ? 'Remote runtime unavailable' : 'Checking runtime…',
        tone: availability.data ? 'warning' : 'muted',
      };
    }
    if (agentState) return { glyph: agentState.glyph, words: agentState.words };
    if (!automation.enabled) return { glyph: 'idle', words: 'Paused' };
    if (!run) return { glyph: 'idle', words: 'No runs yet' };
    const status = runStatusPresentation(run.status);
    const time = run.startedAt ?? run.finishedAt;
    if (!status) return { glyph: 'idle', words: 'Scheduled' };
    return {
      glyph: status.glyph,
      words: time ? (
        <>
          {status.words} <RelativeTime value={time} compact ago />
        </>
      ) : (
        status.words
      ),
    };
  })();

  return (
    <div className="flex w-full min-w-0 items-center gap-4 text-left">
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'min-w-0 truncate text-sm',
            automation.enabled ? 'text-foreground' : 'text-foreground-muted',
            agentState?.glyph === 'needs-you' && 'font-medium'
          )}
        >
          {automation.name}
        </span>
        <MetaLine
          className="min-h-4"
          glyph={state.glyph ? <StateGlyph state={state.glyph} size="sm" /> : undefined}
          start={[
            <span
              key="state"
              className={cn(
                state.tone === 'warning' && 'text-foreground-warning',
                agentState?.glyph === 'needs-you' && 'text-foreground-muted'
              )}
            >
              {state.words}
            </span>,
            automationScheduleLabel(automation),
            projectId ? (
              projectDisplayName(getProjectStore(projectId))
            ) : (
              <span key="project" className="text-foreground-warning">
                No project
              </span>
            ),
          ]}
        />
      </div>

      <span className="shrink-0 text-right text-tiny text-foreground-passive tabular-nums">
        {automation.enabled && scheduledAt ? (
          <>
            Next <AbsoluteTime value={scheduledAt} />
          </>
        ) : null}
      </span>

      {/* The switch is an explicit control: clicks must not reach the row. */}
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex shrink-0 items-center"
      >
        <Switch
          checked={automation.enabled}
          disabled={!runtimeAvailable}
          title={availability.data?.available === false ? availability.data.reason : undefined}
          aria-label={
            automation.enabled ? `Pause ${automation.name}` : `Turn on ${automation.name}`
          }
          onCheckedChange={(checked) => onToggleEnabled?.(checked)}
        />
      </div>
    </div>
  );
});
