import { Select } from '@emdash/ui/react/primitives';
import { FolderGit2, GitBranch, GitPullRequest, GitPullRequestArrow, Layers } from 'lucide-react';
import React from 'react';
import { useTaskConfig } from '@core/features/tasks/contributions/browser/task-config/task-config-context';
import { cn } from '@core/primitives/styling/browser/cn';
import type { WorkspacePresetId, WorkspacePresetMeta } from '@core/primitives/workspaces/api';
import { WORKSPACE_PRESETS } from '@core/primitives/workspaces/api';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const PRESET_ICONS: Record<WorkspacePresetId, React.ReactNode> = {
  'new-worktree': <GitBranch className="size-3.5 shrink-0" />,
  'repo-root': <FolderGit2 className="size-3.5 shrink-0" />,
  'use-existing': <Layers className="size-3.5 shrink-0" />,
  'checkout-pr': <GitPullRequest className="size-3.5 shrink-0" />,
  'pr-new-branch': <GitPullRequestArrow className="size-3.5 shrink-0" />,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PresetOption = WorkspacePresetMeta & {
  disabled: boolean;
  disabledReason?: string;
};

interface WorkspacePresetPickerProps {
  value: WorkspacePresetId;
  onValueChange: (id: WorkspacePresetId) => void;
  hasPR: boolean;
  hasExistingWorkspaces: boolean;
  worktreesDisabledReason?: string;
  disabled?: boolean;
}

/**
 * Where the conductor works. The closed control is one quiet field line (the preset's
 * name); the open list carries each preset's sentence. A reason the chosen preset cannot
 * run shows under the field, in the helper role.
 */
export function WorkspacePresetPicker({
  value,
  onValueChange,
  hasPR,
  hasExistingWorkspaces,
  worktreesDisabledReason,
  disabled,
}: WorkspacePresetPickerProps) {
  const { showPrPresets } = useTaskConfig();

  const options: PresetOption[] = WORKSPACE_PRESETS.filter(
    (preset) => showPrPresets || !preset.requiresPR
  ).map((preset) => ({
    ...preset,
    disabledReason:
      preset.requiresCommits && worktreesDisabledReason ? worktreesDisabledReason : undefined,
    disabled:
      (preset.requiresPR && !hasPR) ||
      (hasPR && !preset.requiresPR) ||
      (preset.requiresCommits && !!worktreesDisabledReason) ||
      (preset.id === 'use-existing' && !hasExistingWorkspaces),
  }));

  const selected = options.find((o) => o.id === value) ?? options[0];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Select.Root
        value={value}
        onValueChange={(nextValue) => onValueChange(nextValue as WorkspacePresetId)}
        disabled={disabled}
      >
        <Select.Trigger appearance="input" aria-label="Workspace">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-foreground-passive">{PRESET_ICONS[value]}</span>
            <span className="truncate">{selected?.label ?? 'Select workspace…'}</span>
          </span>
        </Select.Trigger>

        <Select.Content width="trigger" align="start">
          {options.map((option) => (
            <Select.Item
              key={option.id}
              value={option.id}
              disabled={option.disabled}
              className="h-auto items-start py-2"
            >
              <span className="flex min-w-0 items-start gap-2">
                <span className="mt-0.5 text-foreground-passive">{PRESET_ICONS[option.id]}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{option.label}</span>
                  <span
                    className={cn(
                      'text-xs text-pretty',
                      option.disabledReason ? 'text-foreground-warning' : 'text-foreground-passive'
                    )}
                  >
                    {option.disabledReason ?? option.description}
                  </span>
                </span>
              </span>
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {selected?.disabledReason ? (
        <p className="text-xs text-foreground-warning">{selected.disabledReason}</p>
      ) : null}
    </div>
  );
}
