import { StateGlyph } from '@emdash/ui/react/components';
import { Field, Input, Select, Switch } from '@emdash/ui/react/primitives';
import { Github } from 'lucide-react';
import { useId } from 'react';
import { ProviderIdentityStrip } from '@core/features/integrations/contributions/browser/provider-identity-strip';
import type { GitHubAccountSummary } from '@core/primitives/github/api';
import type { Resolved } from '@core/primitives/project-settings/api';
import { type Strategy } from './add-project-modal';
import { DirectoryField } from './local-directory-selector';
import { type CloneModeState, type CreateRepositoryModeState, type PickModeState } from './modes';
import { OwnerSelector } from './owner-selector';
import { type ProjectDirectoryPickerClient } from './project-directory-picker';

/**
 * The three ways to add a project share one rhythm: labelled fields 20px apart, helper text
 * under a field in the muted helper role, and problems said in words under the field they are
 * about (an error line, never a red box).
 */

export function PickExistingPanel({
  strategy,
  connectionId,
  state,
  getProjectsClient,
  inspectionError,
  showInitializeGitPrompt,
}: {
  strategy: Strategy;
  connectionId?: string;
  state: PickModeState;
  getProjectsClient(): Promise<ProjectDirectoryPickerClient>;
  inspectionError?: string;
  showInitializeGitPrompt: boolean;
}) {
  const initGitId = useId();
  return (
    <>
      <Field.Root>
        <Field.Label>Folder</Field.Label>
        <DirectoryField
          strategy={strategy}
          connectionId={connectionId}
          path={state.path}
          onPathChange={state.handlePathChange}
          getProjectsClient={getProjectsClient}
          title="Select a local project"
          message="Select a project directory to open"
          placeholder={
            strategy === 'ssh' && !connectionId ? 'Choose a machine first' : 'Choose a folder'
          }
          invalid={Boolean(inspectionError)}
        />
        {inspectionError ? (
          <div role="alert" className="flex min-w-0 flex-col gap-1">
            <p className="flex items-center gap-1.5 text-xs text-foreground-error">
              <StateGlyph state="error" size="sm" />
              Could not read this folder.
            </p>
            <p className="font-mono text-xs break-words text-foreground-muted">{inspectionError}</p>
          </div>
        ) : null}
      </Field.Root>
      {showInitializeGitPrompt && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={initGitId} className="text-sm text-foreground">
              Initialize a Git repository here
            </label>
            <p className="text-xs text-foreground-muted">
              This folder is not a Git repository yet. You can also open it as it is and initialize
              Git later from the Changes panel.
            </p>
          </div>
          <Switch
            id={initGitId}
            checked={state.initGitRepository}
            onCheckedChange={state.setinitGitRepository}
          />
        </div>
      )}
    </>
  );
}

export function CreateRepositoryPanel({
  strategy,
  connectionId,
  state,
  getProjectsClient,
  accounts,
  selectedAccount,
  defaultAccount,
  onAccountChange,
  onConnectGithub,
  ensureDefaultRoot,
}: {
  strategy: Strategy;
  connectionId?: string;
  state: CreateRepositoryModeState;
  getProjectsClient(): Promise<ProjectDirectoryPickerClient>;
  accounts: GitHubAccountSummary[];
  selectedAccount: GitHubAccountSummary | null;
  /** The default-account inference the strip shows when nothing is chosen. */
  defaultAccount: GitHubAccountSummary | null;
  onAccountChange: (accountId: string) => void;
  onConnectGithub: () => void;
  ensureDefaultRoot: boolean;
}) {
  const repositoryNameId = useId();
  const visibilityId = useId();

  // No project exists yet, so the strip previews the same inference the
  // resolver would make (the default account) instead of resolver output;
  // there is no per-project setting to remember into.
  const resolvedAccount: Resolved<GitHubAccountSummary | null> = {
    value: defaultAccount,
    provenance: { kind: 'inferred', from: 'default account' },
  };
  const overrideAccount =
    selectedAccount && selectedAccount.accountId !== defaultAccount?.accountId
      ? selectedAccount
      : null;

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,3fr)] items-end gap-2">
          <Field.Root className="min-w-0">
            <Field.Label>Owner</Field.Label>
            <OwnerSelector
              owners={state.owners}
              owner={state.repositoryOwner}
              accounts={accounts}
              selectedAccount={selectedAccount}
              onOwnerChange={state.handleOwnerChange}
              onAccountChange={onAccountChange}
            />
          </Field.Root>
          <span aria-hidden className="pb-1.5 text-sm text-foreground-passive">
            /
          </span>
          <Field.Root className="min-w-0">
            <Field.Label htmlFor={repositoryNameId}>Repository name</Field.Label>
            <Input
              id={repositoryNameId}
              autoFocus
              placeholder="Enter a repository name"
              value={state.repositoryName}
              onChange={(e) => state.handleRepositoryNameChange(e.target.value)}
            />
          </Field.Root>
        </div>
        {state.repositoryOwnersErrorMessage ? (
          <p role="alert" className="text-xs text-foreground-error">
            {state.repositoryOwnersErrorMessage}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={visibilityId} className="text-sm text-foreground">
            Visibility
          </label>
          <p className="text-xs text-foreground-muted">
            Who can see and commit to this repository.
          </p>
        </div>
        <Select.Root
          value={state.repositoryVisibility}
          onValueChange={(value) => state.setRepositoryVisibility(value as 'public' | 'private')}
        >
          <Select.Trigger id={visibilityId} appearance="input" className="w-32 shrink-0">
            {state.repositoryVisibility === 'private' ? 'Private' : 'Public'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="private">Private</Select.Item>
            <Select.Item value="public">Public</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      <Field.Root>
        <Field.Label>{strategy === 'local' ? 'Location' : 'Location on the machine'}</Field.Label>
        <DirectoryField
          strategy={strategy}
          connectionId={connectionId}
          path={state.path}
          onPathChange={state.setPath}
          getProjectsClient={getProjectsClient}
          ensureDefaultRoot={ensureDefaultRoot}
          title="Select a local project"
          message="Select a project directory to open"
        />
      </Field.Root>
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
        override={overrideAccount}
        persistence="action-only"
        accountRequired
        onSelect={(account) => onAccountChange(account.accountId)}
        onConnect={onConnectGithub}
      />
    </>
  );
}

export function ClonePanel({
  strategy,
  connectionId,
  state,
  getProjectsClient,
  ensureDefaultRoot,
}: {
  strategy: Strategy;
  connectionId?: string;
  state: CloneModeState;
  getProjectsClient(): Promise<ProjectDirectoryPickerClient>;
  ensureDefaultRoot: boolean;
}) {
  const repositoryUrlId = useId();
  return (
    <>
      <Field.Root>
        <Field.Label htmlFor={repositoryUrlId}>Repository URL</Field.Label>
        <Input
          id={repositoryUrlId}
          autoFocus
          spellCheck={false}
          placeholder="https://github.com/owner/repository"
          value={state.repositoryUrl}
          onChange={(e) => state.handleRepositoryUrlChange(e.target.value)}
        />
      </Field.Root>
      <Field.Root>
        <Field.Label>{strategy === 'local' ? 'Location' : 'Location on the machine'}</Field.Label>
        <DirectoryField
          strategy={strategy}
          connectionId={connectionId}
          path={state.path}
          onPathChange={state.setPath}
          getProjectsClient={getProjectsClient}
          ensureDefaultRoot={ensureDefaultRoot}
          title="Select a local project"
          message="Select a project directory to open"
        />
      </Field.Root>
    </>
  );
}
