import { StateGlyph } from '@emdash/ui/react/components';
import { Input, Spinner, SplitButton, toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { getTaskGitCheckoutStore } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { formatPushErrorDetail } from '@core/features/source-control/api/git-error-messages';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { formatErrorType } from '@core/features/tasks/api/browser/utils';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useTaskComposition,
  useWorkspace,
  useWorkspaceId,
} from '@core/features/workbench/api/browser/task-composition-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { cn } from '@core/primitives/styling/browser/cn';

type CommitPhase =
  | 'idle'
  | 'committing'
  | 'commit-only-done'
  | 'committed'
  | 'pushing'
  | 'pushed'
  | 'opening-pr';

interface CommitCardProps {
  autoStage?: boolean;
}

export const CommitCard = observer(function CommitCard({ autoStage = false }: CommitCardProps) {
  const { projectId, taskId } = useTaskViewContext();
  const workspaceId = useWorkspaceId();
  const taskView = useTaskComposition();
  const workspace = useWorkspace();
  const git = workspace.get(gitCheckoutStoreToken);
  const diffView = taskView.diffView;
  const changesView = diffView?.changesView ?? null;
  const hasPRs = changesView?.expandedSections.pullRequests ?? false;
  const [commitMessage, setCommitMessage] = useState('');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<CommitPhase>('idle');
  const fullMessage = description ? `${commitMessage}\n\n${description}` : commitMessage;
  const isInFlight = phase !== 'idle';

  const openCreatePrModal = useOpenModal('createPrModal');
  const repositoryUrl = getGitRepositoryStore(projectId)?.pullRequestRepositoryUrl ?? null;

  if (!diffView || !changesView) return null;

  const branchName = getTaskGitCheckoutStore(projectId, taskId)?.branchName;
  const hasOpenPr = taskView.prStore?.pullRequests.some((p) => p.status === 'open') ?? false;
  const canCreatePr = Boolean(repositoryUrl) && Boolean(branchName) && !hasOpenPr;

  const stageAllIfNeeded = async (): Promise<boolean> => {
    if (!autoStage) return true;
    changesView.suppressNextAutoExpand('staged');
    const result = await git.stageAllFiles();
    if (!result.success) {
      toast.error(`Failed to stage changes: ${formatErrorType(result.error)} `);
      setPhase('idle');
      return false;
    }
    return true;
  };

  const doCommit = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const result = await git.commit(fullMessage);
    if (!result.success) {
      toast.error(`Failed to commit changes: ${formatErrorType(result.error)} `);
      setPhase('idle');
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('commit-only-done');
    setTimeout(() => setPhase('idle'), 3000);
  };

  const doCommitAndPush = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const commitResult = await git.commit(fullMessage);
    if (!commitResult.success) {
      toast.error(`Failed to commit changes: ${formatErrorType(commitResult.error)} `);
      setPhase('idle');
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('committed');
    await new Promise((r) => setTimeout(r, 1000));
    setPhase('pushing');
    const pushResult = await git.push();
    if (!pushResult.success) {
      toast.error(`Failed to push: ${formatPushErrorDetail(pushResult.error)}`);
      setPhase('idle');
      return;
    }
    setPhase('pushed');
    setTimeout(() => setPhase('idle'), 3000);
  };

  const doCommitAndCreatePr = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const commitResult = await git.commit(fullMessage);
    if (!commitResult.success) {
      toast.error(`Failed to commit changes: ${formatErrorType(commitResult.error)} `);
      setPhase('idle');
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('opening-pr');
    await new Promise((r) => setTimeout(r, 500));
    setPhase('idle');
    void openCreatePrModal({
      projectId,
      taskId,
      repositoryUrl: repositoryUrl ?? '',
      branchName: branchName ?? '',
      draft: false,
      workspaceId,
    });
  };

  const actions = [
    { id: 'commit', label: 'Commit', action: () => void doCommit() },
    { id: 'commit-push', label: 'Commit & Push', action: () => void doCommitAndPush() },
    ...(canCreatePr
      ? [
          {
            id: 'commit-pr',
            label: 'Commit & Create PR',
            action: () => void doCommitAndCreatePr(),
          },
        ]
      : []),
  ];

  const effectiveAction =
    diffView.effectiveCommitAction === 'commit-pr' && !canCreatePr
      ? 'commit-push'
      : diffView.effectiveCommitAction;

  return (
    // The commit box reads like the conductor composer: one emphasis card with
    // the summary, a description that grows with its text, and the section's
    // one solid move. Progress shows as words on the left of that move.
    <div className="shrink-0 px-2 pt-2 pb-2">
      <div
        className={cn(
          '@container/commit flex flex-col rounded-lg border border-border bg-surface-emphasis transition-[border-color,box-shadow] duration-150',
          'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25'
        )}
      >
        <Input
          bare
          aria-label="Commit message"
          placeholder="Commit message"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          disabled={isInFlight}
          className="px-3"
        />
        <textarea
          aria-label="Commit description"
          placeholder="Description (optional)"
          rows={1}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isInFlight}
          className="field-sizing-content max-h-40 min-h-8 resize-none bg-transparent px-3 pt-0.5 pb-1.5 text-sm leading-normal text-foreground outline-none placeholder:text-foreground-passive disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex min-h-10 items-center justify-between gap-2 pr-2 pb-2 pl-3">
          <CommitProgress phase={phase} autoStage={autoStage} />
          <SplitButton
            options={actions.map(({ id, label }) => ({ id, label }))}
            size="sm"
            disabled={isInFlight || !commitMessage.trim()}
            selectedId={effectiveAction}
            onSelectedChange={(id) =>
              diffView.setCommitAction(id as 'commit' | 'commit-push' | 'commit-pr')
            }
            commitOnSelect={false}
            onAction={(id) => actions.find((a) => a.id === id)?.action()}
            className="min-w-0"
          />
        </div>
      </div>
    </div>
  );
});

const PHASE_WORDS: Record<Exclude<CommitPhase, 'idle'>, string> = {
  committing: 'Committing…',
  'commit-only-done': 'Committed',
  committed: 'Committed',
  pushing: 'Pushing…',
  pushed: 'Pushed',
  'opening-pr': 'Opening PR…',
};

/** Where a commit stands, in words: a passive spinner while it runs, the done ring after. */
function CommitProgress({ phase, autoStage }: { phase: CommitPhase; autoStage: boolean }) {
  if (phase === 'idle') {
    return (
      // In a narrow panel the hint steps aside so the commit button keeps its label.
      <span className="min-w-0 truncate text-tiny text-foreground-passive @max-[17rem]/commit:hidden">
        {autoStage ? 'Stages all changes' : null}
      </span>
    );
  }
  const done = phase === 'commit-only-done' || phase === 'committed' || phase === 'pushed';
  return (
    <span
      role="status"
      className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted motion-safe:animate-in motion-safe:fade-in"
    >
      {done ? (
        <StateGlyph state="done" size="sm" />
      ) : (
        <Spinner size="sm" className="shrink-0 text-foreground-passive" />
      )}
      <span className="truncate">{PHASE_WORDS[phase]}</span>
    </span>
  );
}
