import type { GitBranchRef, GitRemote } from '@emdash/core/runtimes/git/api';
import { deriveWorktreePoolPath } from '@emdash/core/runtimes/workspace-registry/api';
import { SettingsRow, SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Input, Select, Switch } from '@emdash/ui/react/primitives';
import { Folder } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import {
  resolveRendererEffectiveSettings,
  useEffectiveSettingsInputs,
} from '@core/features/projects/api/browser/effective-settings/use-effective-settings';
import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import {
  BrokenSettingNotice,
  ProvenanceBadge,
  ProvenanceSourceLine,
  ResetProvenanceButton,
} from '@core/features/projects/contributions/browser/settings-provenance';
import type { ProvenanceFlavor } from '@core/features/projects/contributions/browser/settings-provenance-labels';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import { RemoteSelector } from '@core/features/source-control/contributions/browser/remote-selector';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import type {
  AgentGitCredentialsSetting,
  Provenance,
  Resolved,
} from '@core/primitives/project-settings/api';
import { formatDefaultBranch, resolveTmux } from '@core/primitives/project-settings/api';
import type { Project } from '@core/primitives/projects/api';
import type { ProjectPlacementDomainSnapshot } from '../../../../api/project-settings-page';
import {
  formToStoredGitSettings,
  storedDefaultBranchToBranchRef,
  type FormUpdate,
  type GitIdentityFormState,
  type IntegrationAccountsFormState,
  type PlacementFormState,
} from '../project-settings-form-model';
import { IntegrationAccountsSection } from './integration-accounts-section';

const AGENT_GIT_CREDENTIALS_OPTIONS: { value: AgentGitCredentialsSetting; label: string }[] = [
  { value: 'effective-account', label: 'Effective account' },
  { value: 'system', label: 'System' },
  { value: 'none', label: 'None' },
];

type BaseProjectSettingsSectionProps = {
  projectId: string;
  gitIdentityForm: GitIdentityFormState;
  integrationAccountsForm: IntegrationAccountsFormState;
  placementForm: PlacementFormState;
  placement: ProjectPlacementDomainSnapshot;
  projectType: Project['type'];
  remotes: GitRemote[];
  worktreeDirectoryError: string | null;
  updateGitIdentity: FormUpdate<GitIdentityFormState>;
  updateIntegrationAccounts: FormUpdate<IntegrationAccountsFormState>;
  updatePlacement: FormUpdate<PlacementFormState>;
  hostActionReason: string | null;
  hostObservationKind: 'fresh' | 'stale' | 'unavailable';
};

/**
 * Per-field provenance treatment (spec: github-git-settings §9, prototype
 * Variant A): label + badge + reset affordance, source line for inferred
 * values, broken-setting warning below the label row. Provenance is resolved
 * over the *pending* form state so edits preview exactly what a save would
 * resolve to.
 */
function ProvenanceField({
  label,
  description,
  resolved,
  flavor = 'inferred',
  isExplicit,
  onReset,
  layout = 'inline',
  children,
}: {
  label: string;
  description: string;
  resolved: Resolved<unknown> | null;
  flavor?: ProvenanceFlavor;
  /** Whether the form currently holds an explicit value (shows the reset affordance). */
  isExplicit: boolean;
  onReset: () => void;
  /** `stacked` for long values (paths); `inline` puts the control on the right at `w-56`. */
  layout?: 'inline' | 'stacked';
  children: ReactNode;
}) {
  const provenance: Provenance | null = resolved?.provenance ?? null;
  // A broken setting explains itself above the control, which needs the full width.
  const rowLayout = provenance?.kind === 'broken-setting' ? 'stacked' : layout;
  return (
    <SettingsRow
      layout={rowLayout}
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {label}
          {provenance ? <ProvenanceBadge provenance={provenance} flavor={flavor} /> : null}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span>{description}</span>
          {provenance ? (
            <span className="flex flex-wrap items-center gap-x-3">
              <ProvenanceSourceLine provenance={provenance} />
              {isExplicit ? <ResetProvenanceButton flavor={flavor} onReset={onReset} /> : null}
            </span>
          ) : null}
        </span>
      }
      controlClassName={rowLayout === 'inline' ? 'w-56' : undefined}
      control={
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          {provenance?.kind === 'broken-setting' ? (
            <BrokenSettingNotice
              staleValue={provenance.staleValue}
              effectiveValue={brokenFallbackDisplay(resolved)}
            />
          ) : null}
          {children}
        </div>
      }
    />
  );
}

function brokenFallbackDisplay(resolved: Resolved<unknown> | null): string | null {
  const value = resolved?.value ?? null;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'branch' in value) {
    return formatDefaultBranch(value as { remote: string | null; branch: string });
  }
  return String(value);
}

export const BaseProjectSettingsSection = observer(function BaseProjectSettingsSection({
  projectId,
  gitIdentityForm,
  integrationAccountsForm,
  placementForm,
  placement,
  projectType,
  remotes,
  worktreeDirectoryError,
  updateGitIdentity,
  updateIntegrationAccounts,
  updatePlacement,
  hostActionReason,
  hostObservationKind,
}: BaseProjectSettingsSectionProps) {
  const inputs = useEffectiveSettingsInputs(projectId);
  const effective = inputs
    ? resolveRendererEffectiveSettings(
        inputs,
        formToStoredGitSettings({ gitIdentity: gitIdentityForm, placement: placementForm })
      )
    : null;
  const [isBrowsingWorktreeDirectory, setIsBrowsingWorktreeDirectory] = useState(false);

  const inheritedWorktreeRoot =
    placement.layers.hostWorktreeRoot ?? placement.layers.builtInWorktreeRoot;
  const projectPath = projectData(getProjectStore(projectId))?.path ?? null;
  const effectiveWorktreeRoot = effective?.worktreeRoot.value ?? null;
  const effectiveTmux = resolveTmux({
    projectTmux: placementForm.tmux,
    hostTmux: placement.layers.hostTmux,
    appDefaultTmux: placement.layers.appDefaultTmux,
  });
  const tmuxSupported = projectType !== 'local' || detectPlatformContext().os !== 'windows';
  const derivedPoolPath =
    projectPath !== null && effectiveWorktreeRoot !== null
      ? deriveWorktreePoolPath({ worktreeRoot: effectiveWorktreeRoot, repoPath: projectPath })
      : null;

  const handleBrowseWorktreeDirectory = async () => {
    if (isBrowsingWorktreeDirectory) return;

    setIsBrowsingWorktreeDirectory(true);
    try {
      const result = await (
        await getHostClient()
      ).openSelectDirectoryDialog({
        title: 'Select worktree root',
        message: 'Choose the directory where worktrees should be created.',
        defaultPath:
          placementForm.worktreeDirectory || (effectiveWorktreeRoot ?? inheritedWorktreeRoot),
      });
      if (result) {
        updatePlacement('worktreeDirectory', result);
      }
    } finally {
      setIsBrowsingWorktreeDirectory(false);
    }
  };

  const effectiveDefaultBranchRef = storedDefaultBranchToBranchRef(
    effective?.defaultBranch.value ?? undefined,
    remotes
  );

  const unavailableCopy =
    projectType === 'local'
      ? 'Worktree placement is unavailable until the local runtime is ready.'
      : 'Worktree placement is unavailable until this Project’s Machine is ready.';

  return (
    <>
      <IntegrationAccountsSection
        integrationAccountsForm={integrationAccountsForm}
        updateIntegrationAccounts={updateIntegrationAccounts}
        repositoryHost={
          inputs && effective
            ? (inputs.repoFacts.remotes.find((remote) => remote.name === effective.baseRemote.value)
                ?.host ?? null)
            : undefined
        }
      />

      <SettingsSection
        title="Git"
        description="Where new tasks branch from, and where this project fetches and pushes."
      >
        <ProvenanceField
          label="Default branch"
          description="The branch new tasks are created from by default."
          resolved={effective?.defaultBranch ?? null}
          isExplicit={gitIdentityForm.defaultBranch !== null}
          onReset={() => updateGitIdentity('defaultBranch', null)}
        >
          <ProjectBranchSelector
            projectId={projectId}
            value={gitIdentityForm.defaultBranch ?? effectiveDefaultBranchRef ?? undefined}
            onValueChange={(branch: GitBranchRef) => updateGitIdentity('defaultBranch', branch)}
          />
        </ProvenanceField>

        <ProvenanceField
          label="Base remote"
          description="Used for fetching remote branches, choosing task base branches and targeting pull requests."
          resolved={effective?.baseRemote ?? null}
          isExplicit={gitIdentityForm.baseRemote.trim() !== ''}
          onReset={() => updateGitIdentity('baseRemote', '')}
        >
          <RemoteSelector
            remotes={remotes}
            value={gitIdentityForm.baseRemote || (effective?.baseRemote.value ?? '')}
            onValueChange={(value) => updateGitIdentity('baseRemote', value)}
            className="w-full"
          />
        </ProvenanceField>

        <ProvenanceField
          label="Push remote"
          description="Used when publishing task branches and pushing commits."
          resolved={effective?.pushRemote ?? null}
          isExplicit={gitIdentityForm.pushRemote.trim() !== ''}
          onReset={() => updateGitIdentity('pushRemote', '')}
        >
          <RemoteSelector
            remotes={remotes}
            value={gitIdentityForm.pushRemote || (effective?.pushRemote.value ?? '')}
            onValueChange={(value) => updateGitIdentity('pushRemote', value)}
            className="w-full"
          />
        </ProvenanceField>

        <SettingsRow
          label="Agent git credentials"
          description="Which git credentials agent and terminal sessions use in this project. Effective account wires the account above, system keeps your machine's credentials, none disables credential helpers in sessions."
          controlClassName="w-56"
          control={
            <Select.Root
              value={gitIdentityForm.agentGitCredentials}
              onValueChange={(value) => {
                if (!value) return;
                updateGitIdentity('agentGitCredentials', value as AgentGitCredentialsSetting);
              }}
            >
              <Select.Trigger appearance="input" className="w-full min-w-0">
                {AGENT_GIT_CREDENTIALS_OPTIONS.find(
                  (option) => option.value === gitIdentityForm.agentGitCredentials
                )?.label ?? 'Effective account'}
              </Select.Trigger>
              <Select.Content align="start" alignItemWithTrigger={false} sideOffset={6}>
                {AGENT_GIT_CREDENTIALS_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Worktrees"
        description="Where task worktrees live and how agent sessions run in them."
      >
        {hostObservationKind === 'unavailable' ? (
          <SettingsRow
            layout="stacked"
            label="Worktree root"
            description={unavailableCopy}
            control={null}
          />
        ) : (
          <>
            <fieldset disabled={hostActionReason !== null} className="contents">
              <ProvenanceField
                layout="stacked"
                label="Worktree root"
                description="Where task worktrees are created."
                resolved={hostActionReason ? null : (effective?.worktreeRoot ?? null)}
                flavor="inherited"
                isExplicit={placementForm.worktreeDirectory.trim() !== ''}
                onReset={() => updatePlacement('worktreeDirectory', '')}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    aria-label="Worktree root"
                    aria-invalid={worktreeDirectoryError ? true : undefined}
                    className="min-w-0 flex-1 font-mono text-xs"
                    spellCheck={false}
                    placeholder={effectiveWorktreeRoot ?? inheritedWorktreeRoot}
                    value={placementForm.worktreeDirectory}
                    onChange={(e) => updatePlacement('worktreeDirectory', e.target.value)}
                  />
                  {projectType === 'local' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="shrink-0"
                      disabled={isBrowsingWorktreeDirectory}
                      onClick={handleBrowseWorktreeDirectory}
                    >
                      <Folder data-icon="inline-start" className="size-4" />
                      Browse
                    </Button>
                  ) : null}
                </div>
                {worktreeDirectoryError ? (
                  <span role="alert" className="text-xs text-foreground-error">
                    {worktreeDirectoryError}
                  </span>
                ) : null}
                {derivedPoolPath ? (
                  <span className="text-xs text-foreground-muted">
                    Worktrees for this repository go in{' '}
                    <code className="rounded-xs bg-surface-hover px-1 font-mono break-all">
                      {derivedPoolPath}
                    </code>
                  </span>
                ) : null}
              </ProvenanceField>
            </fieldset>
            {hostActionReason ? (
              <p role="status" className="text-xs text-foreground-muted">
                Worktree placement is {hostActionReason.toLocaleLowerCase()}
              </p>
            ) : null}
          </>
        )}

        <SettingsRow
          label={
            <span className="inline-flex flex-wrap items-center gap-2">
              Enable tmux
              {tmuxSupported &&
              (hostObservationKind !== 'unavailable' || placementForm.tmux !== undefined) ? (
                <ProvenanceBadge provenance={effectiveTmux.provenance} flavor="inherited" />
              ) : null}
            </span>
          }
          description={
            <span className="flex flex-col gap-0.5">
              <span>
                {!tmuxSupported
                  ? 'tmux is unavailable for local Windows sessions. Your stored preference is preserved.'
                  : hostObservationKind === 'unavailable' && placementForm.tmux === undefined
                    ? 'The inherited tmux value is unavailable. Choose a value to set a Project override.'
                    : 'Run the agent session inside a tmux session.'}
              </span>
              {tmuxSupported && placementForm.tmux !== undefined ? (
                <span>
                  <ResetProvenanceButton
                    flavor="inherited"
                    onReset={() => updatePlacement('tmux', undefined)}
                  />
                </span>
              ) : null}
            </span>
          }
          control={
            <Switch
              aria-label="Enable tmux"
              checked={
                !tmuxSupported
                  ? false
                  : hostObservationKind === 'unavailable'
                    ? (placementForm.tmux ?? false)
                    : effectiveTmux.value
              }
              disabled={!tmuxSupported}
              onCheckedChange={(checked) => updatePlacement('tmux', checked)}
            />
          }
        />
      </SettingsSection>
    </>
  );
});
