import { randomUUID } from 'node:crypto';
import { formatAbsolute, type HostFileRef } from '#primitives/path/api';
import { AUTOMATION_COMPLETION_DEFAULT_TIMEOUT_MS } from '../../api/deployment';
import type { AutomationRun, AutomationRunDelivery } from '../../api/run';
import type { AutomationDeliveryPort } from '../ports/delivery';
import type { AutomationPortError } from '../ports/port-error';
import type { AutomationSessionPort } from '../ports/session-start';
import type { AutomationWorkspacePort } from '../ports/workspace-provisioning';
import { pullRequestText } from './request';
import type { AutomationRunTransitions } from './transitions';

/** Abort reason for an explicit run cancel, as opposed to runtime shutdown. */
export const RUN_CANCELLED_REASON = 'automation-run-cancelled';

export type AutomationRunExecutorOptions = {
  transitions: AutomationRunTransitions;
  workspacePort: AutomationWorkspacePort;
  sessionPort: AutomationSessionPort;
  deliveryPort?: AutomationDeliveryPort;
  createConversationId?: () => string;
  now?: () => number;
};

export type AutomationRunExecutor = (run: AutomationRun, signal: AbortSignal) => Promise<void>;

export function createAutomationRunExecutor(
  options: AutomationRunExecutorOptions
): AutomationRunExecutor {
  const {
    transitions,
    workspacePort,
    sessionPort,
    deliveryPort,
    createConversationId = randomUUID,
    now = Date.now,
  } = options;

  return async (run: AutomationRun, signal: AbortSignal): Promise<void> => {
    const provisionResult = await workspacePort.provision({
      workspace: run.configSnapshot.workspace,
      generatedName: run.generatedName,
      runId: run.id,
      signal,
    });

    if (!provisionResult.success) {
      transitions.markFailed(
        run.id,
        toRunError('provision_workspace', provisionResult.error),
        Date.now()
      );
      return;
    }

    const { workspace, branchName } = provisionResult.data;
    if (!transitions.markStartingSession(run.id, { workspace, branchName })) return;

    const conversationId = createConversationId();
    const startResult = await sessionPort.start({
      conversationId,
      cwd: workspace,
      agent: run.configSnapshot.agent,
      fallbackTitle: run.configSnapshot.name,
      signal,
    });

    if (!startResult.success) {
      transitions.markFailed(run.id, toRunError('start_session', startResult.error), Date.now());
      return;
    }

    // The run is `done` once its session exists, so clients adopt it exactly as they
    // adopt cron runs. Delivery progress rides on the run's `delivery` field while
    // this worker keeps its slot, which is what bounds concurrent agents.
    const done = transitions.markDone(
      run.id,
      { conversationId, sessionId: startResult.data.sessionId },
      Date.now()
    );
    if (!done || !run.configSnapshot.completion) return;

    await deliver(done, { workspace, branchName, conversationId }, signal);
  };

  async function deliver(
    run: AutomationRun,
    session: { workspace: HostFileRef; branchName: string | null; conversationId: string },
    signal: AbortSignal
  ): Promise<void> {
    const completion = run.configSnapshot.completion;
    if (!completion) return;

    const finish = (
      state: AutomationRunDelivery['state'],
      extra: { pullRequestUrl?: string; error?: AutomationPortError } = {}
    ): void => {
      transitions.updateDelivery(run.id, {
        state,
        pullRequestUrl: extra.pullRequestUrl ?? null,
        error: extra.error ?? null,
        finishedAt: now(),
      });
    };

    if (!deliveryPort) {
      finish('failed', { error: { code: 'delivery_unsupported' } });
      return;
    }
    if (!session.branchName) {
      finish('failed', {
        error: { code: 'no_branch', message: 'Pull request delivery needs a worktree branch' },
      });
      return;
    }

    const sessionRef = {
      conversationId: session.conversationId,
      type: run.configSnapshot.agent.type,
    };
    transitions.updateDelivery(run.id, {
      state: 'agent_running',
      pullRequestUrl: null,
      error: null,
      finishedAt: null,
    });

    const outcome = await deliveryPort.awaitSession({
      session: sessionRef,
      timeoutMs: completion.timeoutMs ?? AUTOMATION_COMPLETION_DEFAULT_TIMEOUT_MS,
      signal,
    });

    if (outcome === 'aborted') {
      // Shutdown leaves the delivery in flight; restart recovery marks it interrupted.
      if (signal.reason !== RUN_CANCELLED_REASON) return;
      await deliveryPort.stopSession(sessionRef);
      finish('cancelled');
      return;
    }
    if (outcome === 'timeout') await deliveryPort.stopSession(sessionRef);

    transitions.updateDelivery(run.id, {
      state: 'publishing',
      pullRequestUrl: null,
      error: null,
      finishedAt: null,
    });

    const draft = outcome !== 'clean';
    const published = await deliveryPort.publish(
      {
        cwd: formatAbsolute(session.workspace.path, {
          separator: session.workspace.path.root.kind === 'posix' ? '/' : '\\',
        }),
        branch: session.branchName,
        baseBranch: completion.baseBranch,
        remote: completion.remote,
        ...pullRequestText(run),
        draft,
      },
      signal
    );

    if (signal.aborted) {
      if (signal.reason === RUN_CANCELLED_REASON) finish('cancelled');
      return;
    }
    if (!published.success) {
      finish('failed', { error: published.error });
      return;
    }
    if (published.data.outcome === 'no-changes') {
      if (draft) finish('failed', { error: { code: `agent_${outcome}` } });
      else finish('no_changes');
      return;
    }
    finish(draft ? 'pr_draft' : 'pr_open', { pullRequestUrl: published.data.url });
  }
}

function toRunError(step: 'provision_workspace' | 'start_session', portError: AutomationPortError) {
  return { step, code: portError.code, message: portError.message };
}
