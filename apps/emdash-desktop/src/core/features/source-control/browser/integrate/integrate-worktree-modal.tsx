import {
  shortName,
  type IntegrateResult,
  type IntegrationPreview,
} from '@emdash/core/runtimes/git/api';
import { StateGlyph } from '@emdash/ui/react/components';
import { FactGrid } from '@emdash/ui/react/patterns';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Input,
  ModalLayout,
  SectionLabel,
  Spinner,
  toast,
} from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
import { cn } from '@core/primitives/styling/browser/cn';
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
        toast.info(withAgent ? 'Claude Code is resolving the merge' : 'Resolution task created', {
          description: `${plan.taskName} runs in its own worktree on ${plan.branchName}.`,
          action: {
            label: 'Open task',
            onClick: () => navigate(taskViewDef({ projectId, taskId: params.id })),
          },
        });
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
      setPhase({ kind: 'working', preview, label: 'Merging…' });
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
          toast.success(`Merged ${taskName} into ${shortName(result.data.branch)}`);
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
              message: `${error.message} Review the updated preview before merging.`,
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
  const targetName = preview?.target.branch ? shortName(preview.target.branch) : null;

  return (
    <ModalLayout
      title={targetName ? `Merge into ${targetName}` : `Merge “${taskName}”`}
      description={
        <>
          Brings the committed work from “{taskName}” into the project’s main directory. Nothing is
          pushed.
        </>
      }
      actions={
        phase.kind === 'recovery' && phase.recovery.state === 'started' ? (
          <>
            <Button variant="ghost" onClick={() => complete()}>
              Close
            </Button>
            <Button variant="primary" onClick={() => openTask(recoveryTaskId(phase.recovery))}>
              Open resolution task
            </Button>
          </>
        ) : phase.kind === 'recovery' &&
          (phase.recovery.state === 'declined' || phase.recovery.state === 'failed') ? (
          <>
            <Button variant="ghost" onClick={() => dismiss()}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void loadPreview()}>
              Check again
            </Button>
          </>
        ) : phase.kind === 'done' ? (
          <Button variant="primary" onClick={() => complete()}>
            Close
          </Button>
        ) : phase.kind === 'load-error' ? (
          <>
            <Button variant="ghost" onClick={() => dismiss()}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void loadPreview()}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => dismiss()} disabled={busy}>
              Cancel
            </Button>
            <PrimaryAction
              preview={preview}
              targetName={targetName}
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
        )
      }
    >
      <Dialog.Body className="flex flex-col gap-5 text-sm">
        {notice && (
          <Alert.Root status={notice.status}>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Root>
        )}
        {phase.kind === 'loading' && (
          <p role="status" className="flex items-center gap-2 text-foreground-muted">
            <Spinner size="sm" className="text-foreground-passive" />
            Checking what would change…
          </p>
        )}
        {phase.kind === 'load-error' && (
          <Alert.Root status="destructive">
            <Alert.Title>Could not prepare the merge</Alert.Title>
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
    </ModalLayout>
  );
});

function PrimaryAction({
  preview,
  targetName,
  busy,
  autoResolve,
  claudeAvailable,
  label,
  onIntegrate,
  onResolve,
}: {
  preview: IntegrationPreview | null;
  targetName: string | null;
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
        Merge
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
      : targetName
        ? `Merge into ${targetName}`
        : 'Merge');
  return (
    <Button variant="primary" disabled={disabled} onClick={() => onIntegrate(preview)}>
      {busy && <Spinner size="sm" />}
      {text}
    </Button>
  );
}

/** A quiet group: a group label over its rows. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel as="h3">{label}</SectionLabel>
      {children}
    </section>
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
  const source = preview.source.branch ? shortName(preview.source.branch) : null;
  const target = preview.target.branch ? shortName(preview.target.branch) : null;

  return (
    <>
      {/* What will happen, in one plain sentence, then the facts behind it. */}
      <div className="flex flex-col gap-3">
        <p className="text-base text-pretty text-foreground-body">
          {describeIntegrationPlan(preview)}
        </p>
        <FactGrid labelWidth="5rem">
          {source && (
            <FactGrid.Row label="From">
              <BranchName>{source}</BranchName>
            </FactGrid.Row>
          )}
          <FactGrid.Row label="Into">
            {target ? <BranchName>{target}</BranchName> : 'the main directory'}
          </FactGrid.Row>
          <FactGrid.Row label="Brings">
            {pluralize(preview.ahead, 'commit')}
            {preview.changedFiles.length > 0 && (
              <span className="text-foreground-muted">
                {' · '}
                {pluralize(preview.changedFiles.length, 'file')} changed
              </span>
            )}
          </FactGrid.Row>
        </FactGrid>
      </div>
      {blockers.length > 0 && (
        <Alert.Root status="destructive">
          <Alert.Title>Can’t merge right now</Alert.Title>
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
            Only committed work is merged. Commit everything in the task’s worktree to include it.
            {canCommit && (
              <span className="mt-3 flex gap-2">
                <Input
                  aria-label="Commit message"
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
              </span>
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
        <Group label={`Incoming commits · ${preview.ahead}`}>
          <ul className="flex max-h-36 flex-col gap-1 overflow-auto text-sm">
            {preview.commits.map((commit) => (
              <li key={commit.hash} className="flex min-w-0 items-baseline gap-3">
                <code className="shrink-0 font-mono text-xs text-foreground-passive">
                  {commit.hash.slice(0, 8)}
                </code>
                <span className="min-w-0 truncate text-foreground-body">{commit.subject}</span>
              </li>
            ))}
          </ul>
        </Group>
      )}
      {files.length > 0 && (
        <Group
          label={`${preview.mode === 'conflict' ? 'Conflicting files' : 'Files changed'} · ${files.length}`}
        >
          <ul className="flex max-h-36 flex-col gap-0.5 overflow-auto font-mono text-xs">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li
                key={file}
                className={cn(
                  'flex min-w-0 items-center gap-2 truncate',
                  preview.mode === 'conflict' ? 'text-foreground' : 'text-foreground-muted'
                )}
              >
                {preview.mode === 'conflict' && (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-foreground-warning"
                  />
                )}
                <span className="truncate">{file}</span>
              </li>
            ))}
            {files.length > MAX_LISTED_FILES && (
              <li className="font-sans text-foreground-passive">
                …and {files.length - MAX_LISTED_FILES} more
              </li>
            )}
          </ul>
        </Group>
      )}
    </>
  );
}

/** A branch name in the inline-code role. */
function BranchName({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-surface-emphasis px-1 font-mono text-xs text-foreground">
      {children}
    </code>
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
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          onCheckedChange={(value) => onChange(value === true)}
        />
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

/** An outcome: the state mark, a short headline and one sentence. */
function Outcome({
  glyph,
  title,
  children,
}: {
  glyph: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="status" className="flex items-start gap-2.5">
      <span className="flex h-5 shrink-0 items-center">{glyph}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-sm text-foreground-muted">{children}</p>
      </div>
    </div>
  );
}

function DoneDetails({ result }: { result: IntegrateResult }) {
  const branch = shortName(result.branch);
  return (
    <Outcome
      glyph={<StateGlyph state="done" />}
      title={
        result.mode === 'up-to-date' ? `${branch} already has this work` : `Merged into ${branch}`
      }
    >
      {result.mode === 'up-to-date' ? (
        'Nothing needed to change.'
      ) : (
        <>
          The main directory is now at{' '}
          <code className="font-mono text-xs text-foreground">{result.commit.slice(0, 8)}</code>{' '}
          (was <code className="font-mono text-xs">{result.previousHead.slice(0, 8)}</code>).
          Nothing was pushed.
        </>
      )}
    </Outcome>
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
        <Alert.Title>The merge needs attention</Alert.Title>
        <Alert.Description>
          {failure.reason} The main directory and this task’s worktree were not changed.
        </Alert.Description>
      </Alert.Root>
      {recovery.state === 'creating' && (
        <p role="status" className="flex items-center gap-2 text-foreground-muted">
          <Spinner size="sm" className="text-foreground-passive" />
          {claudeAvailable
            ? 'Starting Claude Code in a new isolated worktree…'
            : 'Creating a resolution task…'}
        </p>
      )}
      {recovery.state === 'started' && (
        <Outcome
          glyph={<StateGlyph state={recovery.withAgent ? 'working' : 'done'} />}
          title={recovery.withAgent ? 'Claude Code is resolving it' : 'Resolution task created'}
        >
          “{plan.taskName}” works on {plan.branchName}, a new branch from {plan.fromBranch}.{' '}
          {recovery.withAgent
            ? 'Claude Code asks before running commands and won’t push. '
            : 'Run the steps below in that task’s terminal. '}
          When the result looks right, use Merge on that task to bring it into {plan.fromBranch}.
        </Outcome>
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
        <Group label="Resolve by hand in a separate worktree or branch">
          <pre className="overflow-auto rounded-md bg-surface-emphasis px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground-body">
            {plan.manualSteps.join('\n')}
          </pre>
        </Group>
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

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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
  size: 'lg',
});
