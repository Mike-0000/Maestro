import { EmptyState } from '@emdash/ui/react/components';
import { CircleDot, GitBranch, GitPullRequest, type LucideIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useConnectedIssueProviders } from '@core/features/integrations/api/browser/use-connected-issue-providers';
import { projectAvailabilityUiContribution as projectAvailabilityUi } from '@core/features/projects/contributions/browser/project-availability-ui';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { taskHostActionAvailability } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { Shortcut } from '@core/primitives/keybindings/browser/shortcut';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { useArrowKeyNavigation } from '@core/primitives/react-hooks/browser/use-arrow-key-navigation';
import { isGitHubDotComHost } from '@core/primitives/repository/api';
import { cn } from '@core/primitives/styling/browser/cn';

interface TaskAction {
  label: string;
  description: string;
  icon: LucideIcon;
  disabled: boolean;
  disabledReason?: string;
  onActivate: () => void;
}

export const TaskListEmptyState = observer(function TaskListEmptyState({
  projectId,
}: {
  projectId: string;
}) {
  const openTaskModal = useOpenModal('taskModal');
  const { navigate } = useNavigate();
  const { hasAnyIssueIntegration } = useConnectedIssueProviders();
  const repositoryStore = getGitRepositoryStore(projectId);
  const supportsPullRequests = Boolean(repositoryStore?.pullRequestRepositoryUrl);
  const supportsGhesIssues = Boolean(
    repositoryStore?.issueRepositoryUrl &&
    repositoryStore.providerRepository?.host &&
    !isGitHubDotComHost(repositoryStore.providerRepository.host)
  );
  const hasAnyIntegration = supportsGhesIssues || hasAnyIssueIntegration;
  const createAvailability = taskHostActionAvailability(projectId);
  const createDisabledReason =
    createAvailability.kind === 'disabled'
      ? (projectAvailabilityUi.getLiveActionDisabledReason(projectId) ??
        projectAvailabilityUi.defaultLiveActionDisabledReason)
      : undefined;

  const actions: TaskAction[] = [
    {
      label: 'From a branch',
      description: 'Start on a branch that already exists.',
      icon: GitBranch,
      disabled: !!createDisabledReason,
      disabledReason: createDisabledReason,
      onActivate: () => void openTaskModal({ projectId, strategy: 'from-branch' }),
    },
    {
      label: 'From an issue',
      description: hasAnyIntegration
        ? 'Link an issue and start from it.'
        : 'Connect an issue tracker first.',
      icon: CircleDot,
      disabled: !!createDisabledReason,
      disabledReason: createDisabledReason,
      onActivate: () =>
        hasAnyIntegration
          ? void openTaskModal({ projectId, strategy: 'from-issue' })
          : navigate(settingsViewDef({ tab: 'integrations' })),
    },
    {
      label: 'From a pull request',
      description: 'Start from an open pull request.',
      icon: GitPullRequest,
      disabled: !!createDisabledReason || !supportsPullRequests,
      disabledReason: createDisabledReason ?? 'No remote repository connected',
      onActivate: () => void openTaskModal({ projectId, strategy: 'from-pull-request' }),
    },
  ];

  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(actions.length, (index) => {
    const action = actions[index];
    if (action && !action.disabled) action.onActivate();
  });

  // The page-level empty state: a quiet title, one sentence, then the three ways in as a short
  // list. Arrow keys move through it and Enter starts the highlighted one (its keycap shows).
  return (
    <EmptyState
      bare
      size="page"
      label="No conductors yet"
      description="Start one from a branch, an issue or a pull request."
      action={
        <div className="flex w-80 max-w-full flex-col gap-0.5 text-left">
          {actions.map((action, i) => (
            <TaskActionRow
              key={action.label}
              action={action}
              isSelected={i === selectedIndex}
              onMouseEnter={() => setSelectedIndex(i)}
            />
          ))}
        </div>
      }
    />
  );
});

function TaskActionRow({
  action,
  isSelected,
  onMouseEnter,
}: {
  action: TaskAction;
  isSelected: boolean;
  onMouseEnter: () => void;
}) {
  const { label, description, icon: Icon, disabled, disabledReason, onActivate } = action;
  return (
    <button
      type="button"
      aria-label={disabledReason ? `${label}. ${disabledReason}` : label}
      disabled={disabled}
      onClick={disabled ? undefined : onActivate}
      onMouseEnter={disabled ? undefined : onMouseEnter}
      className={cn(
        'flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-hover',
        !disabled && isSelected && 'bg-surface-hover'
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="size-4 shrink-0 text-foreground-passive" aria-hidden />
        <div className="flex min-w-0 flex-col">
          <span
            className={cn(
              'truncate text-sm text-foreground-muted transition-colors',
              !disabled && isSelected && 'text-foreground'
            )}
          >
            {label}
          </span>
          <span className="truncate text-xs text-foreground-passive">
            {disabled && disabledReason ? disabledReason : description}
          </span>
        </div>
      </div>
      {!disabled && isSelected && <Shortcut hotkey="Enter" variant="keycaps" />}
    </button>
  );
}
