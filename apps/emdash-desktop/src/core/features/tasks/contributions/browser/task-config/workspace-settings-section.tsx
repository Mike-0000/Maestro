import { Collapsible, Tabs } from '@emdash/ui/react/primitives';
import { CheckoutPrPanel } from '@core/features/tasks/browser/task-config/checkout-pr-panel';
import { NewWorktreePanel } from '@core/features/tasks/browser/task-config/new-worktree-panel';
import type { WorkspacePanelProps } from '@core/features/tasks/browser/task-config/new-worktree-panel';
import { PrNewBranchPanel } from '@core/features/tasks/browser/task-config/pr-new-branch-panel';
import { UseExistingPanel } from '@core/features/tasks/browser/task-config/use-existing-panel';
import { WorkspacePresetPicker } from '@core/features/tasks/browser/task-config/workspace-preset-picker';
import { WorktreeDestinationPreview } from '@core/features/tasks/browser/task-config/worktree-destination-preview';
import { useTaskState } from '@core/features/tasks/contributions/browser/task-config/task-state-context';
import type { WorkspacePresetId } from '@core/primitives/workspaces/api';

const PRESET_PANELS: Record<
  Exclude<WorkspacePresetId, 'repo-root'>,
  React.ComponentType<WorkspacePanelProps>
> = {
  'new-worktree': NewWorktreePanel,
  'use-existing': UseExistingPanel,
  'checkout-pr': CheckoutPrPanel,
  'pr-new-branch': PrNewBranchPanel,
};

/** Presets with no configurable settings — the collapsible is disabled for these. */
const PRESETS_WITHOUT_SETTINGS = new Set<WorkspacePresetId>(['repo-root']);

interface WorkspaceSettingsSectionProps {
  defaultOpen?: boolean;
}

/**
 * Where the conductor works: the preset as one field line, then a quiet "Branch and setup"
 * disclosure for the preset's details (with the checkout / new-branch choice as underline text
 * tabs on the same line), then the resolved worktree path in the caption role.
 */
export function WorkspaceSettingsSection({ defaultOpen = true }: WorkspaceSettingsSectionProps) {
  const { workspaceConfig, projectId, isUnborn, hasRepository, hasPR } = useTaskState();

  const { presetId, branchSelection } = workspaceConfig;
  const { createBranchAndWorktree, setCreateBranchAndWorktree } = branchSelection;

  const worktreesDisabledReason = !hasRepository
    ? 'Folder is not a Git repository'
    : isUnborn
      ? 'Repository has no commits yet'
      : undefined;
  const hasSettings = !PRESETS_WITHOUT_SETTINGS.has(presetId);
  const Panel = PRESET_PANELS[presetId as Exclude<WorkspacePresetId, 'repo-root'>];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WorkspacePresetPicker
        value={presetId}
        onValueChange={workspaceConfig.setPresetId}
        hasPR={hasPR}
        hasExistingWorkspaces={workspaceConfig.workspaceOptions.some(
          (workspace) => !!workspace.workspaceId && !workspace.disabledReason
        )}
        worktreesDisabledReason={worktreesDisabledReason}
      />
      {hasSettings && (
        <Collapsible.Root
          key={presetId}
          // Reusing a workspace needs the pick itself, so that panel never starts hidden.
          defaultOpen={defaultOpen || presetId === 'use-existing'}
          className="flex flex-col"
        >
          <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <Collapsible.Trigger variant="text">
              {presetId === 'use-existing' ? 'Which workspace' : 'Branch and setup'}
            </Collapsible.Trigger>
            {presetId === 'new-worktree' && (
              <Tabs.Root
                value={createBranchAndWorktree ? 'create' : 'checkout'}
                onValueChange={(v) => setCreateBranchAndWorktree(v === 'create')}
              >
                <Tabs.List variant="underline" aria-label="Branch">
                  <Tabs.Tab value="checkout" size="xs">
                    Checkout branch
                  </Tabs.Tab>
                  <Tabs.Tab value="create" size="xs">
                    Create new branch
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.Root>
            )}
          </div>

          <Collapsible.Panel className="flex flex-col">
            <div className="pt-3 pb-1">
              <Panel workspaceConfig={workspaceConfig} projectId={projectId} isUnborn={isUnborn} />
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {projectId ? (
        <WorktreeDestinationPreview
          projectId={projectId}
          workspaceConfig={workspaceConfig.resolvedConfig}
        />
      ) : null}
    </div>
  );
}
