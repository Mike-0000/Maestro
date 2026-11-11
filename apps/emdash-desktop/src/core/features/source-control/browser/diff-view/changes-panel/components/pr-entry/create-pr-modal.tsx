import type { GitBranchRef } from '@emdash/core/runtimes/git/api';
import {
  Alert,
  Button,
  Combobox,
  Dialog,
  Field,
  Input,
  ModalLayout,
  SplitButton,
  Textarea,
} from '@emdash/ui/react/primitives';
import { ArrowRight, ChevronDown, GitBranch, Github, GitPullRequest } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useRef, useState } from 'react';
import { useProjectAccount } from '@core/features/integrations/api/browser/use-project-account';
import { useAccounts } from '@core/features/integrations/api/browser/use-provider-accounts';
import { identityStripView } from '@core/features/integrations/api/identity-strip-state';
import { ProviderIdentityStrip } from '@core/features/integrations/contributions/browser/provider-identity-strip';
import { getProjectSettingsStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { BrokenSettingNotice } from '@core/features/projects/contributions/browser/settings-provenance';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { formatPushErrorDetail } from '@core/features/source-control/api/git-error-messages';
import { BranchDisplay } from '@core/features/source-control/contributions/browser/branch-display';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import { RemoteSelector } from '@core/features/source-control/contributions/browser/remote-selector';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import { workspaceRegistry } from '@core/features/workspaces/api/browser/stores/workspace-registry';
import { useModalController, useOpenModal } from '@core/manifests/browser/modal-api';
import { isGitHubAccountSummary } from '@core/primitives/github/api';
import type { GitHubAccountSummary } from '@core/primitives/github/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { log } from '@core/primitives/logging/browser/logger';
import { defineModal } from '@core/primitives/modals/react';
import { parseRepositoryRef } from '@core/primitives/repository/api';
import { pullRequestErrorMessage } from '@core/services/pull-requests/api';
import { getPullRequestsRuntimeClient } from '@core/services/pull-requests/api/client';
import { resolveInitialBaseBranch } from './base-branch';
import { getTargetRemotes, resolveCreatePrTargetRemote } from './target-remote';

export type CreatePrModalArgs = {
  projectId: string;
  taskId: string;
  repositoryUrl: string;
  branchName: string;
  draft: boolean;
  workspaceId: string;
};

export const CreatePrModal = observer(function CreatePrModal({
  projectId,
  taskId: _taskId,
  repositoryUrl,
  branchName,
  draft,
  workspaceId,
}: CreatePrModalArgs) {
  const { complete, dismiss } = useModalController('createPrModal');
  const openIntegrationSetup = useOpenModal('integrationSetupModal');
  const [title, setTitle] = useState(branchName);
  const [description, setDescription] = useState('');
  const [selectedBaseOverride, setSelectedBaseOverride] = useState<GitBranchRef | undefined>();
  const [selectedTargetRemoteName, setSelectedTargetRemoteName] = useState<string | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [createActionId, setCreateActionId] = useState('push-and-create');
  const [error, setError] = useState<string | null>(null);
  const [accountOverride, setAccountOverride] = useState<GitHubAccountSummary | null>(null);
  const [accountSaveState, setAccountSaveState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const accountSaveInFlight = useRef(false);
  const repo = getGitRepositoryStore(projectId);
  const checkout = workspaceRegistry.get(workspaceId)?.get(gitCheckoutStoreToken);
  // Identity strip inputs (spec §9): the resolver's effective account plus the
  // per-action override. Create-PR is fail-closed (spec §5/§7): while the
  // inputs load or when no account resolves, the primary action stays blocked.
  const resolvedAccount = useProjectAccount(projectId, 'github', {
    repository: { kind: 'project' },
    accepts: isGitHubAccountSummary,
  });
  const { data: accounts } = useAccounts('github', isGitHubAccountSummary);
  const identityBlocked =
    accountSaveState !== 'idle' ||
    !resolvedAccount ||
    !accounts ||
    identityStripView('GitHub', resolvedAccount, accountOverride, accounts).kind !== 'account';
  // The PR execution path resolves *as whom* node-side from the stored
  // per-project setting, so a popover selection persists immediately (the
  // popover says so) instead of riding a per-action parameter.
  const handleSelectAccount = async (account: GitHubAccountSummary) => {
    if (accountSaveInFlight.current || isCreating) return;
    accountSaveInFlight.current = true;
    setAccountSaveState('saving');
    setAccountOverride(account);
    setError(null);
    try {
      const settings = getProjectSettingsStore(projectId);
      if (!settings) throw new Error('Project settings are unavailable.');
      const result = await settings.save({
        integrationAccounts: {
          stored: { github: { kind: 'account', accountId: account.accountId } },
        },
      });
      if (!result.success) throw new Error('Could not save the selected account.');
      setAccountSaveState('idle');
    } catch {
      setAccountSaveState('failed');
      setError(
        'Could not save the selected account. Select it again to retry before creating the PR.'
      );
    } finally {
      accountSaveInFlight.current = false;
    }
  };
  const defaultBranch = repo?.defaultBranchRef;
  const needsPush = !checkout?.isPublished || checkout.aheadCount > 0;
  const baseRemoteResolution = repo?.effectiveGitSettings.baseRemote ?? null;
  const projectRemoteName = repo?.baseRemote?.name ?? null;
  const fallbackRepository = useMemo(() => parseRepositoryRef(repositoryUrl), [repositoryUrl]);
  const targetRemotes = useMemo(
    () =>
      fallbackRepository
        ? getTargetRemotes(repo?.remotes ?? [], { host: fallbackRepository.host })
        : [],
    [fallbackRepository, repo?.remotes]
  );
  const targetRemote = resolveCreatePrTargetRemote({
    options: targetRemotes,
    projectRemoteName,
    selectedRemoteName: selectedTargetRemoteName,
    fallbackRepositoryUrl: repositoryUrl,
  });
  const targetRepositoryUrl =
    targetRemote?.repository.repositoryUrl ?? fallbackRepository?.repositoryUrl ?? null;

  const hasGitHubRemote = Boolean(targetRepositoryUrl);
  const selectedBase =
    selectedBaseOverride ??
    resolveInitialBaseBranch(
      repo?.branchRefs.filter((branch) => branch.type === 'remote') ?? [],
      undefined,
      defaultBranch,
      targetRemote?.remote.name ?? projectRemoteName
    );

  const handleTargetRemoteChange = (remoteName: string) => {
    setSelectedTargetRemoteName(remoteName);
    setSelectedBaseOverride(undefined);
  };

  const doCreate = async (push: boolean) => {
    if (identityBlocked || accountSaveInFlight.current || isCreating) return;
    if (!selectedBase?.branch) {
      setError('Select a base branch before creating the pull request.');
      return;
    }
    if (!title.trim() || !targetRepositoryUrl) return;
    setError(null);
    setIsCreating(true);
    try {
      if (push) {
        const workspace = workspaceRegistry.get(workspaceId);
        if (!workspace) throw new Error('Workspace is unavailable');
        const pushResult = await workspace.get(gitCheckoutStoreToken).push();
        if (!pushResult.success) {
          log.error('Failed to push branch:', pushResult.error);
          setError(formatPushErrorDetail(pushResult.error));
          return;
        }
      }

      const baseRepository = parseRepositoryRef(targetRepositoryUrl);
      const headRepository = repo?.pushRemote?.url ? parseRepositoryRef(repo.pushRemote.url) : null;
      const head =
        baseRepository &&
        headRepository &&
        headRepository.repositoryUrl !== baseRepository.repositoryUrl
          ? `${headRepository.owner}:${branchName}`
          : branchName;

      const client = await getPullRequestsRuntimeClient();
      const result = await client.createPullRequest({
        repositoryUrl: targetRepositoryUrl,
        headRepositoryUrl: headRepository?.repositoryUrl,
        head,
        base: selectedBase.branch,
        title: title.trim(),
        body: description.trim() || undefined,
        draft,
      });

      if (result.success) {
        complete();
      } else {
        setError(pullRequestErrorMessage(result.error));
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ModalLayout
      title={draft ? 'Create draft pull request' : 'Create pull request'}
      description="Opens a pull request on GitHub from this task’s branch."
      actions={
        <>
          <Button variant="ghost" onClick={() => dismiss()} disabled={isCreating}>
            Cancel
          </Button>
          {needsPush ? (
            <SplitButton
              size="base"
              loading={isCreating}
              loadingLabel="Creating..."
              disabled={
                !hasGitHubRemote || !selectedBase?.branch || !title.trim() || identityBlocked
              }
              options={[
                {
                  id: 'push-and-create',
                  label: draft ? 'Push & Create Draft' : 'Push & Create PR',
                },
                {
                  id: 'create-only',
                  label: draft ? 'Create Draft' : 'Create PR',
                  description: 'Skip push and open a PR from the current remote state',
                },
              ]}
              selectedId={createActionId}
              onSelectedChange={setCreateActionId}
              commitOnSelect={false}
              onAction={(id) => void doCreate(id === 'push-and-create')}
            />
          ) : (
            <ConfirmButton
              variant="primary"
              onClick={() => void doCreate(false)}
              disabled={
                !hasGitHubRemote ||
                !selectedBase?.branch ||
                !title.trim() ||
                isCreating ||
                identityBlocked
              }
            >
              {isCreating ? 'Creating...' : draft ? 'Create Draft' : 'Create PR'}
            </ConfirmButton>
          )}
        </>
      }
    >
      <Dialog.Body className="flex max-h-[70vh] flex-col gap-5">
        {!hasGitHubRemote && (
          <Alert.Root status="warning">
            <Alert.Description>
              No GitHub remote detected. Configure a GitHub remote to create pull requests.
            </Alert.Description>
          </Alert.Root>
        )}
        {baseRemoteResolution?.provenance.kind === 'broken-setting' ? (
          <BrokenSettingNotice
            staleValue={baseRemoteResolution.provenance.staleValue}
            effectiveValue={baseRemoteResolution.value}
          />
        ) : null}
        {/* From → into: the task branch (fixed), then where it lands. */}
        <div className="grid grid-cols-1 items-end gap-x-3 gap-y-5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <BranchDisplay label="Head branch" branchName={branchName} />
          <ArrowRight aria-hidden className="mb-2 hidden size-4 text-foreground-passive sm:block" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-foreground-muted">Base branch</span>
            <ProjectBranchSelector
              projectId={projectId}
              value={selectedBase}
              onValueChange={setSelectedBaseOverride}
              remoteOnly
              remoteName={targetRemote?.remote.name}
              branchLabelRemote="short"
              trigger={
                <Combobox.Trigger
                  aria-label="Base branch"
                  className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border px-2.5 text-left text-sm text-foreground transition-colors outline-none hover:border-border-1 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring emlight:border-border-1"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranch aria-hidden className="size-3.5 shrink-0 text-foreground-passive" />
                    <span className="min-w-0 truncate">
                      <Combobox.Value placeholder="Select a base branch" />
                    </span>
                  </span>
                  <ChevronDown aria-hidden className="size-4 shrink-0 text-foreground-passive" />
                </Combobox.Trigger>
              }
            />
          </div>
        </div>
        {targetRemotes.length > 1 && targetRemote ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-foreground-muted">Target repository</span>
            <RemoteSelector
              remotes={targetRemotes.map(({ remote }) => remote)}
              value={targetRemote.remote.name}
              onValueChange={handleTargetRemoteChange}
              className="w-full"
              renderTrigger={(selected) => (
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <GitPullRequest
                    aria-hidden
                    className="size-3.5 shrink-0 text-foreground-passive"
                  />
                  <span className="min-w-0 truncate">
                    {selected?.label ?? targetRemote.remote.name}
                  </span>
                </span>
              )}
            />
          </div>
        ) : null}
        <Field.Group>
          <Field.Root>
            <Field.Label>Title</Field.Label>
            <Input
              placeholder="PR title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!hasGitHubRemote}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>Description</Field.Label>
            <Textarea
              value={description}
              placeholder="What changed and why (optional)"
              onChange={(e) => setDescription(e.target.value)}
              rows={1}
              disabled={!hasGitHubRemote}
            />
          </Field.Root>
        </Field.Group>
        {resolvedAccount && accounts ? (
          <ProviderIdentityStrip
            providerName="GitHub"
            providerIcon={<Github className="size-4 text-foreground-muted" />}
            actionLabel="Creating as"
            emptyState={{
              connect: 'Connect a GitHub account to continue.',
              unavailable: 'Choose a GitHub account to continue.',
              noMatch: 'No connected account matches this repository.',
            }}
            resolved={resolvedAccount}
            accounts={accounts}
            override={accountOverride}
            persistence="project"
            accountRequired
            disabled={accountSaveState === 'saving' || isCreating}
            onSelect={(account) => void handleSelectAccount(account)}
            onConnect={() => void openIntegrationSetup({ integration: 'github' })}
          />
        ) : null}
        {error && (
          <Alert.Root status="destructive">
            <Alert.Title>Failed to create pull request</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        )}
      </Dialog.Body>
    </ModalLayout>
  );
});

export const createPrModal = defineModal<void>()({
  id: 'createPrModal',
  component: CreatePrModal,
  size: 'md',
});
