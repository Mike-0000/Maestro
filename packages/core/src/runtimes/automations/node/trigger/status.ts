import type { AutomationRun } from '#runtimes/automations/api';

export type TriggerRequestStatus =
  | 'queued'
  | 'provisioning'
  | 'agent_running'
  | 'publishing'
  | 'pr_open'
  | 'pr_draft'
  | 'no_changes'
  | 'failed'
  | 'cancelled';

export type TriggerRequestView = {
  requestId: string;
  runId: string;
  status: TriggerRequestStatus;
  branch: string | null;
  pullRequestUrl: string | null;
  error: { code: string; message?: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
};

const TERMINAL_STATUSES: ReadonlySet<TriggerRequestStatus> = new Set([
  'pr_open',
  'pr_draft',
  'no_changes',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: TriggerRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Collapses the run's session-start status and its delivery into one caller-facing status. */
export function requestView(run: AutomationRun): TriggerRequestView {
  const base = {
    requestId: run.request?.id ?? run.id,
    runId: run.id,
    branch: run.branchName,
    pullRequestUrl: run.delivery?.pullRequestUrl ?? null,
    startedAt: run.startedAt,
  };

  switch (run.status) {
    case 'scheduled':
    case 'queued':
      return { ...base, status: 'queued', error: null, finishedAt: null };
    case 'provisioning_workspace':
    case 'starting_session':
      return { ...base, status: 'provisioning', error: null, finishedAt: null };
    case 'cancelled':
      return { ...base, status: 'cancelled', error: null, finishedAt: run.finishedAt };
    case 'failed':
    case 'skipped':
      return {
        ...base,
        status: 'failed',
        error: run.error
          ? { code: run.error.code, ...(run.error.message && { message: run.error.message }) }
          : { code: run.status },
        finishedAt: run.finishedAt,
      };
    case 'done':
      // Without a delivery the automation has no pull-request completion: the
      // session started and the agent is on its own.
      return {
        ...base,
        status: run.delivery?.state ?? 'agent_running',
        error: run.delivery?.error ?? null,
        finishedAt: run.delivery?.finishedAt ?? null,
      };
  }
}
