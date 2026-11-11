import type { AutomationRun } from '@emdash/core/runtimes/automations/api';
import { toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { isAutomationRunAdoptable } from '@core/features/automations/api/automation-run';
import { useAutomationRunActions } from '@core/features/automations/browser/use-automation-run-actions';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import {
  getRegisteredTaskData,
  getTaskIdForAutomationRun,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { formatAutomationError, formatRunDeliveryLabel } from '../automation-run-format';
import { useAutomationRun } from '../use-automations';
import { RunMetaLine } from './RunMetaLine';
import { TaskDataLine } from './TaskDataLine';
import { TaskPlaceholder } from './TaskPlaceholder';

/** Statuses in which a run may still create its task. */
const PENDING_STATUSES = new Set<AutomationRun['status']>([
  'scheduled',
  'queued',
  'provisioning_workspace',
  'starting_session',
  'done',
]);

interface AutomationRunRowProps {
  runId: string;
  automationId: string;
  projectId: string | null;
  run?: AutomationRun;
}

export const AutomationRunRow = observer(function AutomationRunRow({
  runId,
  automationId,
  projectId,
  run: runProp,
}: AutomationRunRowProps) {
  const { navigate } = useNavigate();
  const fetchedRun = useAutomationRun(projectId!, automationId, runId);
  const run = runProp ?? fetchedRun;
  const { adoptRun, isAdopting, runtimeAvailable } = useAutomationRunActions(
    automationId,
    projectId
  );

  const taskId = run && projectId ? getTaskIdForAutomationRun(projectId, run.id) : null;
  const taskStore = taskId && projectId ? getTaskStore(projectId, taskId) : undefined;
  const task = taskId && projectId ? getRegisteredTaskData(projectId, taskId) : undefined;
  const interactive = Boolean(
    projectId &&
    ((taskId && !task?.archivedAt) ||
      (!taskId && runtimeAvailable && run && isAutomationRunAdoptable(run) && !isAdopting))
  );
  const agentStatus = taskStore ? taskAgentStatus(taskStore) : null;
  const displayTime = run ? (run.startedAt ?? run.finishedAt) : null;
  const missedDeadline = run?.error?.code === 'deadline_exceeded';
  const displayName = run?.generatedName ?? null;

  async function handleOpenTask() {
    if (!projectId || !interactive) return;
    try {
      const adopted = taskId ? { taskId, projectId } : await adoptRun(runId);
      navigate(taskViewDef(adopted));
    } catch (error) {
      toast.error('Could not open automation run', {
        description: formatAutomationError(error),
      });
    }
  }

  if (!run) return null;

  return (
    <div
      className={cn(
        // A two-line row on the sheet: separated by rhythm and the hover step, no rules.
        '-mx-2 flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors outline-none',
        'focus-visible:ring-1 focus-visible:ring-ring',
        interactive ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default'
      )}
      role="button"
      tabIndex={interactive ? 0 : -1}
      onClick={interactive ? () => void handleOpenTask() : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void handleOpenTask();
            }
          : undefined
      }
      aria-label={
        taskStore
          ? `Open ${taskStore.displayName}`
          : displayName
            ? `Open ${displayName}`
            : 'Open run'
      }
      aria-disabled={!interactive}
    >
      {taskStore ? (
        <TaskDataLine task={taskStore} agentStatus={agentStatus} missedDeadline={missedDeadline} />
      ) : (
        <TaskPlaceholder
          name={displayName}
          pending={PENDING_STATUSES.has(run.status)}
          fallback={run.triggerKind === 'manual' ? 'Manual run' : 'Scheduled run'}
        />
      )}
      <RunMetaLine
        displayTime={displayTime}
        triggerKind={run.triggerKind}
        runStatus={run.status}
        error={run.error}
      />
      {run.delivery && (
        <div className="flex min-w-0 items-center gap-x-3 text-tiny text-foreground-muted">
          <span className="min-w-0 truncate">{formatRunDeliveryLabel(run.delivery)}</span>
          {run.delivery.pullRequestUrl && (
            <button
              type="button"
              title={run.delivery.pullRequestUrl}
              className="shrink-0 rounded-xs text-link underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                if (run.delivery?.pullRequestUrl) void openExternal(run.delivery.pullRequestUrl);
              }}
            >
              Open pull request
            </button>
          )}
        </div>
      )}
    </div>
  );
});
