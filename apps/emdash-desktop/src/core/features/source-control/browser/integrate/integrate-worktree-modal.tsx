import {
  shortName,
  type IntegrateResult,
  type IntegrationPreview,
} from '@emdash/core/runtimes/git/api';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Input,
  Spinner,
  toast,
} from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getSourceControlClient } from '@core/features/source-control/api/browser/client';
import { getTaskGitCheckoutStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { useModalController } from '@core/manifests/browser/modal-api';
import { agentSupportsInitialPromptDelivery } from '@core/primitives/agents/api';
import { log } from '@core/primitives/logging/browser/logger';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import {
  buildResolutionPlan,
  buildResolutionTaskParams,
  describeIntegrationPlan,
  integrationBlockers,
  RESOLUTION_AGENT_PROVIDER,
  type IntegrationFailure,
  type ResolutionPlan,
} from './integration-recovery';

/** Integration can compute a merge over a large history; allow more than the default timeout. */
const INTEGRATION_TIMEOUT_MS = 120_000;
const MAX_LISTED_FILES = 12;

type IntegrateWorktreeModalArgs = {
  projectId: string;
  taskId: string;
};

type Recovery =
  | { state: 'creating'; plan: ResolutionPlan }
  | { state: 'started'; plan: ResolutionPlan; taskId: string; withAgent: boolean }
  | { state: 'failed'; plan: ResolutionPlan; message: string }
  | { state: 'declined'; plan: ResolutionPlan };

type Phase =
  | { kind: 'loading' }
  | { kind: 'load-error'; message: string }
  | { kind: 'ready'; preview: IntegrationPreview }
  | { kind: 'working'; preview: IntegrationPreview; label: string }
  | { kind: 'done'; result: IntegrateResult }
  | { kind: 'recovery'; failure: IntegrationFailure; recovery: Recovery };

type Notice = { status: 'warning' | 'destructive'; message: string } | null;

export const IntegrateWorktreeModal = observer(function IntegrateWorktreeModal({
  projectId,
  taskId,
}: IntegrateWorktreeModalArgs) {
  const { complete, dismiss } = useModalController('integrateWorktreeModal');
  const { navigate } = useNavigate();
  const task = getTaskStore(projectId, taskId);
  const workspaceId = task?.workspaceId;
  const taskName = task?.data.name ?? 'task';
  const checkoutStore = getTaskGitCheckoutStore(projectId, taskId);
  const { value: projectSettings } = useAppSettingsKey('project');
  const { data: agents, isLoading: agentsLoading } = useAgents(
    hostRefFromConnectionId(getProjectSshConnectionId(projectId))
  );
  const claude = agents?.find((agent) => agent.id === RESOLUTION_AGENT_PROVIDER);
  const claudeAvailable = claude?.status === 'available';

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  const [autoResolve, setAutoResolve] = useState(true);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const busy =
    phase.kind === 'working' ||
    committing ||
    (phase.kind === 'recovery' && phase.recovery.state === 'creating');
  useCloseGuard(busy);

  const loadPreview = useCallback(async () => {
    if (!workspaceId) {
      setPhase({ kind: 'load-error', message: 'This task has no worktree yet.' });
      return;
    }
    setPhase({ kind: 'loading' });
    try {
      const client = await getSourceControlClient();
      const result = await client.checkout.previewIntegration(
        { workspaceId },
        { timeoutMs: INTEGRATION_TIMEOUT_MS }
      );
      setPhase(
        result.success
          ? { kind: 'ready', preview: result.data }
          : { kind: 'load-error', message: result.error.message }
      );
    } catch (error) {
      setPhase({ kind: 'load-error', message: errorMessage(error) });
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const startRecovery = useCallback(
    async (preview: IntegrationPreview, failure: IntegrationFailure, create: boolean) => {
      const { target, source } = preview;
      if (!target.branch || !target.head || !source.head) {
        setPhase({ kind: 'load-error', message: failure.reason });
        return;
      }
      const plan = buildResolutionPlan({
        sourceTaskName: taskName,
        sourceBranch: source.branch,
        sourceHead: source.head,
        targetBranch: target.branch,
        targetHead: target.head,
        failure,
        branchPrefix: projectSettings?.branchPrefix ?? '',
        suffix: Math.random().toString(36).slice(2, 7),
      });
      if (!create) {
        setPhase({ kind: 'recovery', failure, recovery: { state: 'declined', plan } });
        return;
      }
      const manager = getTaskManagerStore(projectId);
      if (!manager) {
        setPhase({
          kind: 'recovery',
          failure,
          recovery: { state: 'failed', plan, message: 'The project is not available.' },
        });
        return;
      }
      setPhase({ kind: 'recovery', failure, recovery: { state: 'creating', plan } });
      const withAgent = claudeAvailable;
      const params = buildResolutionTaskParams(
        projectId,
        plan,
        withAgent
          ? { initialPromptSupported: agentSupportsInitialPromptDelivery(claude?.capabilities) }
          : null
      );
      try {
        await manager.createTask(params);
        setPhase({
          kind: 'recovery',
          failure,
          recovery: { state: 'started', plan, taskId: params.id, withAgent },
        });
        toast.info(
          withAgent ? 'Claude Code is resolving the integration' : 'Resolution task created',
          {
            description: `${plan.taskName} runs in its own worktree on ${plan.branchName}.`,
            action: {
              label: 'Open task',
              onClick: () => navigate(taskViewDef({ projectId, taskId: params.id })),
            },
          }
        );
      } catch (error) {
        log.error('integration: failed to create resolution task', error);
        setPhase({
          kind: 'recovery',
          failure,
          recovery: { state: 'failed', plan, message: errorMessage(error) },
        });
      }
    },
    [claude, claudeAvailable, navigate, projectId, projectSettings, taskName]
  );

  const integrate = useCallback(
    async (preview: IntegrationPreview) => {
      if (!workspaceId || !preview.target.head || !preview.source.head) return;
      if (preview.mode === 'conflict') {
        await startRecovery(
          preview,
          {
            reason: 'The merge has conflicts that need a decision.',
            conflictedFiles: preview.conflictedFiles,
          },
          autoResolve
        );
        return;
      }
      setNotice(null);
      setPhase({ kind: 'working', preview, label: 'Integrating…' });
      try {
        const client = await getSourceControlClient();
        const result = await client.checkout.integrate(
          {
            workspaceId,
            expectedTargetHead: preview.target.head,
            expectedSourceHead: preview.source.head,
          },
          { timeoutMs: INTEGRATION_TIMEOUT_MS }
        );
        if (result.success) {
          setPhase({ kind: 'done', result: result.data });
          toast.success(`Integrated ${taskName} into ${shortName(result.data.branch)}`);
          return;
        }
        const error = result.error;
        switch (error.type) {
          case 'conflict':
            await startRecovery(
              preview,
              { reason: error.message, conflictedFiles: error.conflictedFiles ?? [] },
              autoResolve
            );
            return;
          case 'target_moved':
          case 'source_moved':
            setNotice({
              status: 'warning',
              message: `${error.message} Review the updated preview before integrating.`,
            });
            await loadPreview();
            return;
          case 'blocked':
          case 'local_changes':
            setNotice({ status: 'destructive', message: error.message });
            await loadPreview();
            return;
          case 'git_error':
            if (preview.mode === 'merge') {
              // The merge itself failed after preview said it was clean; hand it to an isolated
              // task rather than retrying anything against the main directory.
              await startRecovery(
                preview,
                { reason: error.message, conflictedFiles: [] },
                autoResolve
              );
              return;
            }
            setNotice({ status: 'destructive', message: error.message });
            setPhase({ kind: 'ready', preview });
            return;
          default:
            setNotice({ status: 'destructive', message: error.message });
            setPhase({ kind: 'ready', preview });
        }
      } catch (error) {
        setNotice({ status: 'destructive', message: errorMessage(error) });
        setPhase({ kind: 'ready', preview });
      }
    },
    [autoResolve, loadPreview, startRecovery, taskName, workspaceId]
  );

  const commitTaskChanges = useCallback(async () => {
    const message = commitMessage.trim();
    if (!checkoutStore || !message) return;
    setCommitting(true);
    setNotice(null);
    try {
      await checkoutStore.stageAllFiles();
      const result = await checkoutStore.commit(message);
      if (!result.success) {
        setNotice({
          status: 'destructive',
          message: `Commit failed: ${errorMessage(result.error)}`,
        });
        return;
      }
      setCommitMessage('');
      await loadPreview();
    } catch (error) {
      setNotice({ status: 'destructive', message: `Commit failed: ${errorMessage(error)}` });
    } finally {
      setCommitting(false);
    }
  }, [checkoutStore, commitMessage, loadPreview]);

  const openTask = (id: string) => {
    navigate(taskViewDef({ projectId, taskId: id }));
    complete();
  };

  const preview = phase.kind === 'ready' || phase.kind === 'working' ? phase.preview : null;
  const targetName = preview?.target.branch ? shortName(preview.target.branch) : 'main';

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Integrate into {targetName}</Dialog.Title>
        <Dialog.Description>
          Bring the committed work from “{taskName}” into the project’s main directory.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Body className="space-y-3 text-sm">
        {notice && (
          <Alert.Root status={notice.status}>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Root>
        )}
        {phase.kind === 'loading' && (
          <div className="flex items-center gap-2 text-foreground-muted">
            <Spinner size="sm" /> Checking what would change…
          </div>
        )}
        {phase.kind === 'load-error' && (
          <Alert.Root status="destructive">
            <Alert.Title>Could not prepare the integration</Alert.Title>
            <Alert.Description>{phase.message}</Alert.Description>
          </Alert.Root>
        )}
        {preview && (
          <PreviewDetails
            preview={preview}
            commitMessage={commitMessage}
            committing={committing}
            canCommit={!!checkoutStore}
            onCommitMessageChange={setCommitMessage}
            onCommit={() => void commitTaskChanges()}
          />
        )}
        {preview && (preview.mode === 'merge' || preview.mode === 'conflict') && (
          <ResolveOption
            checked={autoResolve}
            onChange={setAutoResolve}
            claudeAvailable={claudeAvailable}
            agentsLoading={agentsLoading}
          />
        )}
        {phase.kind === 'done' && <DoneDetails result={phase.result} />}
        {phase.kind === 'recovery' && (
          <RecoveryDetails
            failure={phase.failure}
            recovery={phase.recovery}
            claudeAvailable={claudeAvailable}
          />
        )}
      </Dialog.Body>
      <Dialog.Footer>
        {phase.kind === 'recovery' && phase.recovery.state === 'started' ? (
          <>
            <Button variant="secondary" onClick={() => complete()}>
              Close
            </Button>
            <Button variant="primary" onClick={() => openTask(recoveryTaskId(phase.recovery))}>
              Open resolution task
            </Button>
          </>
        ) : phase.kind === 'recovery' &&
          (phase.recovery.state === 'declined' || phase.recovery.state === 'failed') ? (
          <>
            <Button variant="secondary" onClick={() => dismiss()}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void loadPreview()}>
              Check again
            </Button>
          </>
        ) : phase.kind === 'done' || phase.kind === 'load-error' ? (
          <Button
            variant="secondary"
            onClick={() => (phase.kind === 'done' ? complete() : dismiss())}
          >
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => dismiss()} disabled={busy}>
              Cancel
            </Button>
            <PrimaryAction
              preview={preview}
              busy={busy}
              autoResolve={autoResolve}
              claudeAvailable={claudeAvailable}
              label={phase.kind === 'working' ? phase.label : null}
              onIntegrate={(value) => void integrate(value)}
              onResolve={(value) =>
                void startRecovery(
                  value,
                  {
                    reason: integrationBlockers(value).join(' '),
                    conflictedFiles: [],
                  },
                  true
                )
              }
            />
          </>
        )}
      </Dialog.Footer>
    </>
  );
});

function PrimaryAction({
  preview,
  busy,
  autoResolve,
  claudeAvailable,
  label,
  onIntegrate,
  onResolve,
}: {
  preview: IntegrationPreview | null;
  busy: boolean;
  autoResolve: boolean;
  claudeAvailable: boolean;
  label: string | null;
  onIntegrate: (preview: IntegrationPreview) => void;
  onResolve: (preview: IntegrationPreview) => void;
}) {
  if (!preview) {
    return (
      <Button variant="primary" disabled>
        Integrate
      </Button>
    );
  }
  const blockers = integrationBlockers(preview);
  // An old Git that cannot preview merges can still be resolved in an isolated task.
  const onlyMergeUnsupported =
    preview.blockers.length > 0 &&
    preview.blockers.every((blocker) => blocker.kind === 'merge-unsupported') &&
    blockers.length === preview.blockers.length;
  if (onlyMergeUnsupported) {
    return (
      <Button variant="primary" disabled={busy} onClick={() => onResolve(preview)}>
        {claudeAvailable ? 'Merge with Claude Code' : 'Create merge task'}
      </Button>
    );
  }
  const disabled = busy || blockers.length > 0 || preview.mode === 'up-to-date';
  const text =
    label ??
    (preview.mode === 'conflict'
      ? !autoResolve
        ? 'Show resolution steps'
        : claudeAvailable
          ? 'Resolve with Claude Code'
          : 'Create resolution task'
      : preview.mode === 'merge'
        ? 'Merge and integrate'
        : 'Integrate');
  return (
    <Button variant="primary" disabled={disabled} onClick={() => onIntegrate(preview)}>
      {busy && <Spinner size="sm" />}
      {text}
    </Button>
  );
}

function PreviewDetails({
  preview,
  commitMessage,
  committing,
  canCommit,
  onCommitMessageChange,
  onCommit,
}: {
  preview: IntegrationPreview;
  commitMessage: string;
  committing: boolean;
  canCommit: boolean;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
}) {
  const blockers = integrationBlockers(preview);
  const sourceDirty = hasChanges(preview.source.changes);
  const targetDirty = hasChanges(preview.target.changes);
  const files = preview.mode === 'conflict' ? preview.conflictedFiles : preview.changedFiles;
  const hasOverlapBlocker = preview.blockers.some((blocker) => blocker.kind === 'local-changes');

  return (
    <>
      <p>{describeIntegrationPlan(preview)}</p>
      {blockers.length > 0 && (
        <Alert.Root status="destructive">
          <Alert.Title>Can’t integrate right now</Alert.Title>
          <Alert.Description>
            <ul className="list-disc space-y-1 pl-4">
              {blockers.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert.Description>
        </Alert.Root>
      )}
      {sourceDirty && (
        <Alert.Root status="warning">
          <Alert.Title>This task has uncommitted changes</Alert.Title>
          <Alert.Description>
            Only committed work is integrated. Commit everything in the task’s worktree to include
            it.
            {canCommit && (
              <div className="mt-2 flex gap-2">
                <Input
                  value={commitMessage}
                  placeholder="Commit message"
                  onChange={(event) => onCommitMessageChange(event.target.value)}
                  disabled={committing}
                />
                <Button
                  variant="secondary"
                  disabled={committing || commitMessage.trim().length === 0}
                  onClick={onCommit}
                >
                  {committing ? 'Committing…' : 'Commit all'}
                </Button>
              </div>
            )}
          </Alert.Description>
        </Alert.Root>
      )}
      {targetDirty && !hasOverlapBlocker && (
        <Alert.Root status="info">
          <Alert.Description>
            The main directory has uncommitted changes. They don’t touch the incoming files and will
            be kept as they are.
          </Alert.Description>
        </Alert.Root>
      )}
      {preview.commits.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-foreground-muted">
            Incoming commits ({preview.ahead})
          </h3>
          <ul className="max-h-32 space-y-0.5 overflow-auto text-xs">
            {preview.commits.map((commit) => (
              <li key={commit.hash} className="flex gap-2">
                <code className="shrink-0 text-foreground-muted">{commit.hash.slice(0, 8)}</code>
                <span className="truncate">{commit.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {files.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-foreground-muted">
            {preview.mode === 'conflict' ? 'Conflicting files' : 'Files changed'} ({files.length})
          </h3>
          <ul className="max-h-32 space-y-0.5 overflow-auto font-mono text-xs">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
            {files.length > MAX_LISTED_FILES && (
              <li className="text-foreground-muted">…and {files.length - MAX_LISTED_FILES} more</li>
            )}
          </ul>
        </section>
      )}
    </>
  );
}

function ResolveOption({
  checked,
  onChange,
  claudeAvailable,
  agentsLoading,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  claudeAvailable: boolean;
  agentsLoading: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
        {claudeAvailable
          ? 'If the merge fails, start Claude Code in a new isolated task to resolve it'
          : 'If the merge fails, create a new isolated task for resolving it'}
      </label>
      {!claudeAvailable && !agentsLoading && (
        <p className="pl-6 text-xs text-foreground-muted">
          Claude Code isn’t available on this host, so the task will open without an agent and
          include the steps to resolve it yourself.
        </p>
      )}
    </div>
  );
}

function DoneDetails({ result }: { result: IntegrateResult }) {
  const branch = shortName(result.branch);
  return (
    <Alert.Root status="success">
      <Alert.Title>
        {result.mode === 'up-to-date'
          ? `${branch} already has this work`
          : `Integrated into ${branch}`}
      </Alert.Title>
      <Alert.Description>
        {result.mode === 'up-to-date'
          ? 'Nothing needed to change.'
          : `The main directory is now at ${result.commit.slice(0, 8)} ` +
            `(was ${result.previousHead.slice(0, 8)}). Nothing was pushed.`}
      </Alert.Description>
    </Alert.Root>
  );
}

function RecoveryDetails({
  failure,
  recovery,
  claudeAvailable,
}: {
  failure: IntegrationFailure;
  recovery: Recovery;
  claudeAvailable: boolean;
}) {
  const { plan } = recovery;
  return (
    <>
      <Alert.Root status={recovery.state === 'failed' ? 'destructive' : 'warning'}>
        <Alert.Title>The integration needs attention</Alert.Title>
        <Alert.Description>
          {failure.reason} The main directory and this task’s worktree were not changed.
        </Alert.Description>
      </Alert.Root>
      {recovery.state === 'creating' && (
        <div className="flex items-center gap-2 text-foreground-muted">
          <Spinner size="sm" />
          {claudeAvailable
            ? 'Starting Claude Code in a new isolated worktree…'
            : 'Creating a resolution task…'}
        </div>
      )}
      {recovery.state === 'started' && (
        <Alert.Root status="info">
          <Alert.Title>
            {recovery.withAgent ? 'Claude Code is resolving it' : 'Resolution task created'}
          </Alert.Title>
          <Alert.Description>
            “{plan.taskName}” works on {plan.branchName}, a new branch from {plan.fromBranch}.{' '}
            {recovery.withAgent
              ? 'Claude Code asks before running commands and won’t push. '
              : 'Run the steps below in that task’s terminal. '}
            When the result looks right, use Integrate on that task to bring it into{' '}
            {plan.fromBranch}.
          </Alert.Description>
        </Alert.Root>
      )}
      {recovery.state === 'failed' && (
        <Alert.Root status="destructive">
          <Alert.Title>Could not create the resolution task</Alert.Title>
          <Alert.Description>{recovery.message}</Alert.Description>
        </Alert.Root>
      )}
      {(recovery.state === 'failed' ||
        recovery.state === 'declined' ||
        (recovery.state === 'started' && !recovery.withAgent)) && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-foreground-muted">
            Resolve by hand in a separate worktree or branch
          </h3>
          <pre className="overflow-auto rounded bg-background-2 p-2 text-xs">
            {plan.manualSteps.join('\n')}
          </pre>
        </section>
      )}
    </>
  );
}

function recoveryTaskId(recovery: Recovery): string {
  return recovery.state === 'started' ? recovery.taskId : '';
}

function hasChanges(changes: IntegrationPreview['source']['changes']): boolean {
  if (!changes) return false;
  return changes.staged + changes.unstaged + changes.untracked + changes.conflicted > 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export const integrateWorktreeModal = defineModal<void>()({
  id: 'integrateWorktreeModal',
  component: IntegrateWorktreeModal,
  size: 'md',
});
