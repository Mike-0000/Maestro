import { Button, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { useClaudeAccountPicker } from '@core/features/claude-accounts/contributions/browser/claude-account-picker';
import { useConnectedIssueProviders } from '@core/features/integrations/api/browser/use-connected-issue-providers';
import {
  firstAvailableProjectId,
  getProjectStore,
  projectData as selectProjectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { useProjectGitContext } from '@core/features/tasks/api/browser/create-task-modal/use-project-git-context';
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { taskHostActionAvailability } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { ConversationField } from '@core/features/tasks/contributions/browser/task-config/conversation-field';
import { useInitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { TaskStateProvider } from '@core/features/tasks/contributions/browser/task-config/task-state-context';
import { WorkspaceSettingsSection } from '@core/features/tasks/contributions/browser/task-config/workspace-settings-section';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import type { PullRequest } from '@core/services/pull-requests/api';
import { DetailRow } from './detail-row';
import { LinkedEntitySection } from './linked-entity-section';
import { TaskNameField } from './task-name-field';
import { useCreateTaskCallback } from './use-create-task-callback';
import { type LinkedType, useCreateTaskState } from './use-create-task-state';

function useDefaultProjectId(propProjectId?: string): string | undefined {
  return useMemo(() => {
    if (propProjectId) return propProjectId;
    const nav = getNavigation();
    const params = nav.currentRef.params as { projectId?: string };
    const navProjectId =
      nav.currentViewId === 'task' || nav.currentViewId === 'project'
        ? params.projectId
        : undefined;
    return navProjectId ?? firstAvailableProjectId();
    // oxlint-disable-next-line react/exhaustive-deps
  }, []); // computed once on mount
}

export const CreateTaskModal = observer(function CreateTaskModal({
  projectId,
  strategy: initialStrategy = 'from-branch',
  initialPR,
  initialWorkspaceId,
}: {
  projectId?: string;
  strategy?: 'from-branch' | 'from-issue' | 'from-pull-request';
  initialPR?: PullRequest;
  initialWorkspaceId?: string;
}) {
  const { complete, dismiss } = useModalController('taskModal');
  const selectedProjectId = useDefaultProjectId(projectId);

  const projectData = selectedProjectId
    ? selectProjectData(getProjectStore(selectedProjectId))
    : null;

  const { defaultBranch, isUnborn, hasRepository, currentBranch, repositoryWorkspaceId } =
    useProjectGitContext(selectedProjectId);

  const repositoryStore = selectedProjectId ? getGitRepositoryStore(selectedProjectId) : undefined;
  const pullRequestRepositoryUrl = repositoryStore?.pullRequestRepositoryUrl ?? undefined;
  const repositoryUrl = repositoryStore?.canonicalRepositoryUrl ?? pullRequestRepositoryUrl;

  const projectPath = projectData?.path;

  const { hasAnyIssueIntegration } = useConnectedIssueProviders({ repositoryUrl, projectPath });
  const hasPrSupport = !!pullRequestRepositoryUrl;

  const defaultLinkedType = useMemo((): LinkedType => {
    if (initialStrategy === 'from-pull-request') return 'pr';
    if (initialStrategy === 'from-issue') return 'issue';
    if (hasAnyIssueIntegration) return 'issue';
    if (hasPrSupport) return 'pr';
    return null;
    // oxlint-disable-next-line react/exhaustive-deps
  }, []); // computed once on mount

  const resolvedInitialPR = initialStrategy === 'from-pull-request' ? initialPR : undefined;
  const state = useCreateTaskState(
    selectedProjectId,
    defaultBranch,
    isUnborn,
    hasRepository,
    currentBranch,
    repositoryWorkspaceId,
    resolvedInitialPR,
    defaultLinkedType,
    initialWorkspaceId
  );

  const { autoApproveByDefault, includeIssueContextByDefault } = useTaskSettings();
  const initialConversation = useInitialConversationState(
    selectedProjectId,
    undefined,
    autoApproveByDefault
  );
  const claudeAccount = useClaudeAccountPicker(initialConversation.provider, {
    remote: Boolean(initialConversation.connectionId),
  });
  const { navigate } = useNavigate();

  const { handleCreateTask, canCreate } = useCreateTaskCallback({
    selectedProjectId,
    state,
    initialConversation,
    claudeAccountId: claudeAccount.claudeAccountId,
    navigate,
    onCreated: complete,
  });
  const createAvailability = selectedProjectId
    ? taskHostActionAvailability(selectedProjectId)
    : ({ kind: 'disabled' } as const);
  const createDisabledReason = !selectedProjectId
    ? 'Select a Project.'
    : createAvailability.kind === 'disabled'
      ? (projectAvailabilityUi.getLiveActionDisabledReason(selectedProjectId) ??
        projectAvailabilityUi.defaultLiveActionDisabledReason)
      : undefined;

  // Prompt first, options quiet, one primary action (design brief 2.9). The prompt with its
  // agent row leads; the name, the issue or PR it starts from and the workspace follow as
  // labelled detail rows; the footer holds Cancel and the one Create.
  return (
    <ModalLayout
      title="New conductor"
      leading={
        createDisabledReason ? (
          <span className="text-xs text-foreground-muted">{createDisabledReason}</span>
        ) : undefined
      }
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <ConfirmButton
            variant="primary"
            onClick={handleCreateTask}
            disabled={
              !canCreate || initialConversation.issueContextEditorOpen || !!createDisabledReason
            }
            title={createDisabledReason}
            aria-label={createDisabledReason ? `Create. ${createDisabledReason}` : 'Create'}
          >
            Create
          </ConfirmButton>
        </>
      }
    >
      <Dialog.Body>
        <TaskStateProvider
          workspaceConfig={state.workspaceConfig}
          initialConversation={initialConversation}
          projectId={selectedProjectId}
          isUnborn={isUnborn}
          hasRepository={hasRepository}
          hasPR={state.linkedType === 'pr' && state.linkedPR !== null}
          linkedIssue={state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined}
          includeIssueContextByDefault={includeIssueContextByDefault}
        >
          <ConversationField claudeAccount={claudeAccount} autoFocus />
          <div className="flex flex-col gap-3 pt-1 pb-3">
            <TaskNameField state={state.taskName} />
            <LinkedEntitySection
              state={state}
              hasAnyIssueIntegration={hasAnyIssueIntegration}
              hasPrSupport={hasPrSupport}
              projectId={selectedProjectId}
              repositoryUrl={repositoryUrl}
              projectPath={projectPath}
            />
            <DetailRow label="Workspace">
              <WorkspaceSettingsSection defaultOpen={!!initialWorkspaceId} />
            </DetailRow>
          </div>
        </TaskStateProvider>
      </Dialog.Body>
    </ModalLayout>
  );
});

export const taskModal = defineModal<void>()({
  id: 'taskModal',
  component: CreateTaskModal,
  size: 'lg',
  ignoreOutsidePressAfterWindowBlur: true,
});
