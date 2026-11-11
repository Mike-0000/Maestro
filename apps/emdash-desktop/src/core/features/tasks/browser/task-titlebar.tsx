import {
  Badge,
  Button,
  SectionLabel,
  Popover,
  Toggle,
  ToggleGroup,
  Tooltip,
} from '@emdash/ui/react/primitives';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock,
  FileDiff,
  FolderOpen,
  GitBranch,
  Pin,
  RefreshCcw,
  Terminal,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { ConnectionStatusDot } from '@core/features/machines/contributions/browser/connection-status-dot';
import {
  asAvailableProject,
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { OpenInMenu } from '@core/features/settings/contributions/browser/open-in-menu';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import { useGitActions } from '@core/features/source-control/api/browser/use-git-actions';
import { gitCheckoutStoreToken } from '@core/features/source-control/contributions/browser/workspace-store-tokens';
import {
  getRegisteredTaskData,
  getTaskStore,
  taskDisplayName,
  taskViewKind,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { type SidebarTab } from '@core/features/tasks/api/browser/types';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import {
  useTaskComposition,
  useWorkspace,
} from '@core/features/workbench/api/browser/task-composition-context';
import { Titlebar } from '@core/features/workbench/contributions/browser/Titlebar';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { formatDiffLineCount } from '@core/primitives/formatting/browser/format-diff-line-count';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { linkedIssueDisplayIdentifier, type LinkedIssue } from '@core/primitives/linked-issues/api';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { ActivityBadge } from './components/activity-badge';
import { AutomationRunPill } from './components/automation-run-pill';
import { IssueSelector, ProviderLogo } from './components/issue-selector/issue-selector';
import { PreviewServerPills } from './components/preview-servers/preview-server-pills';

/** The project crumb: quieter than the task, and a link back to the project. */
const CRUMB_LINK =
  'rounded-sm text-foreground-passive transition-colors outline-none hover:text-foreground-muted focus-visible:ring-1 focus-visible:ring-ring';

export const TaskTitlebar = observer(function TaskTitlebar() {
  const { projectId, taskId } = useTaskViewContext();
  const taskStore = getTaskStore(projectId, taskId);
  const kind = taskViewKind(taskStore, projectId);

  if (kind !== 'ready') {
    return <PendingTaskTitlebar taskId={taskId} projectId={projectId} />;
  }

  return <ActiveTaskTitlebar taskId={taskId} projectId={projectId} />;
});

const PendingTaskTitlebar = observer(function PendingTaskTitlebar({
  taskId,
  projectId,
}: {
  taskId: string;
  projectId: string;
}) {
  const taskStore = getTaskStore(projectId, taskId);
  const projectName = projectDisplayName(getProjectStore(projectId));
  const name = taskDisplayName(taskStore);
  const { navigate } = useNavigate();

  return (
    <Titlebar
      leftSlot={
        <div className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-foreground-muted">
          <button
            type="button"
            className={CRUMB_LINK}
            onClick={() => navigate(projectViewDef({ projectId }))}
          >
            {projectName}
          </button>
          <span aria-hidden className="text-foreground-passive">
            /
          </span>
          <span className="max-w-56 truncate">{name}</span>
        </div>
      }
    />
  );
});

const ActiveTaskTitlebar = observer(function ActiveTaskTitlebar({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const taskStore = getTaskStore(projectId, taskId);
  const taskPayload = getRegisteredTaskData(projectId, taskId);
  const workspace = useWorkspace();
  const taskView = useTaskComposition();
  const gitCheckout = workspace.get(gitCheckoutStoreToken);
  gitCheckout.start();

  const {
    isPublished,
    aheadCount,
    behindCount,
    fetch,
    pull,
    push,
    publish,
    isPublishing,
    isFetching,
    isPulling,
    isPushing,
  } = useGitActions(projectId, taskId);

  const linesAdded = gitCheckout.totalLinesAdded;
  const linesDeleted = gitCheckout.totalLinesDeleted;
  const hasDiffStats = linesAdded > 0 || linesDeleted > 0;

  const projectContext = asAvailableProject(getProjectStore(projectId));

  const projectName = projectDisplayName(getProjectStore(projectId));
  const { navigate } = useNavigate();

  if (!taskStore || !taskPayload) return null;

  const isRemoteProject = projectContext?.project.type === 'ssh';
  return (
    <Titlebar
      leftSlot={
        <div className="flex min-w-0 items-center gap-1.5 px-2 text-xs">
          <button
            type="button"
            className={CRUMB_LINK}
            onClick={() => navigate(projectViewDef({ projectId }))}
          >
            {projectName}
          </button>
          <span aria-hidden className="text-foreground-passive">
            /
          </span>
          <Popover.Root>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Popover.Trigger className="-mx-1 flex h-6 items-center gap-1 rounded-sm px-1 text-foreground-muted transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-popup-open:text-foreground">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="max-w-56 truncate">{taskDisplayName(taskStore)}</span>
                      <ConnectionStatusDot state={workspace.connectionState} />
                    </span>
                    <ChevronDown className="size-3 shrink-0 text-foreground-passive" />
                  </Popover.Trigger>
                }
              />
              <Tooltip.Content>Link to issue</Tooltip.Content>
            </Tooltip.Root>
            {/* The task card (design brief 2.10): name as the headline, the branch with its
                sync actions as quiet ghost buttons, then the linked issue. Space, no boxes. */}
            <Popover.Content align="start" className="w-96">
              <div className="flex w-full min-w-0 flex-col gap-0.5">
                <SectionLabel>Task</SectionLabel>
                <span className="truncate text-sm font-semibold text-foreground">
                  {taskDisplayName(taskStore)}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
                  <GitBranch className="size-3.5 shrink-0 text-foreground-passive" />
                  <span className="truncate font-mono">{gitCheckout.branchName}</span>
                </span>
                <div className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-1">
                  {isPublished ? (
                    <>
                      <Tooltip.Root>
                        <Tooltip.Trigger className="flex-1">
                          <Button
                            className="w-full"
                            variant="ghost"
                            size="xs"
                            disabled={isFetching}
                            onClick={() => fetch()}
                          >
                            <RefreshCcw className="size-3" />
                            {isFetching ? 'Fetching...' : 'Fetch'}
                          </Button>
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          {isFetching ? 'Fetching...' : 'Fetch changes'}
                        </Tooltip.Content>
                      </Tooltip.Root>
                      <Tooltip.Root>
                        <Tooltip.Trigger className="flex-1">
                          <Button
                            className="w-full"
                            variant="ghost"
                            disabled={isPulling || behindCount === 0}
                            size="xs"
                            onClick={() => pull()}
                          >
                            <ArrowDown className="size-3" />
                            {isPulling ? (
                              'Pulling...'
                            ) : (
                              <span className="flex items-center gap-1">
                                Pull
                                <Badge>{behindCount}</Badge>
                              </span>
                            )}
                          </Button>
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          {isPulling
                            ? 'Pulling...'
                            : behindCount === 0
                              ? 'Nothing to pull'
                              : 'Pull changes'}
                        </Tooltip.Content>
                      </Tooltip.Root>
                      <Tooltip.Root>
                        <Tooltip.Trigger className="flex-1">
                          <Button
                            className="w-full"
                            variant="ghost"
                            disabled={isPushing || aheadCount === 0}
                            size="xs"
                            onClick={() => push()}
                          >
                            <ArrowUp className="size-3" />
                            {isPushing ? (
                              'Pushing...'
                            ) : (
                              <span className="flex items-center gap-1">
                                Push
                                <Badge>{aheadCount}</Badge>
                              </span>
                            )}
                          </Button>
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                          {isPushing
                            ? 'Pushing...'
                            : aheadCount === 0
                              ? 'Nothing to push'
                              : 'Push changes'}
                        </Tooltip.Content>
                      </Tooltip.Root>
                    </>
                  ) : (
                    <Tooltip.Root>
                      <Tooltip.Trigger className="flex-1">
                        <Button
                          className="w-full"
                          variant="ghost"
                          disabled={isPublishing || gitCheckout.headKind !== 'branch'}
                          size="xs"
                          onClick={() => publish()}
                        >
                          <ArrowUp className="size-3" />
                          {isPublishing ? 'Publishing...' : 'Publish'}
                        </Button>
                      </Tooltip.Trigger>
                      <Tooltip.Content>
                        {isPublishing
                          ? 'Publishing...'
                          : gitCheckout.headKind === 'unborn'
                            ? 'Create an initial commit first'
                            : 'Publish branch'}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  )}
                </div>
              </div>
              <IssueSelector
                value={taskPayload.linkedIssue ?? null}
                onValueChange={(issue) => {
                  void taskStore.updateLinkedIssue(issue ?? undefined);
                }}
                projectId={projectId}
                repositoryUrl={getGitRepositoryStore(projectId)?.canonicalRepositoryUrl ?? ''}
                projectPath={workspace.path}
                excludeTaskId={taskId}
              />
            </Popover.Content>
          </Popover.Root>
          {taskPayload.linkedIssue ? <LinkedIssueBadge issue={taskPayload.linkedIssue} /> : null}
          {taskPayload.type === 'task' && (
            <button
              type="button"
              aria-label="Pin task"
              aria-pressed={taskPayload.isPinned}
              className={cn(
                'flex size-6 items-center justify-center rounded-sm transition-colors outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                taskPayload.isPinned ? 'text-foreground-muted' : 'text-foreground-passive'
              )}
              onClick={() => taskStore.setPinned(!taskPayload.isPinned)}
            >
              <Pin className="size-3.5" fill={taskPayload.isPinned ? 'currentColor' : 'none'} />
            </button>
          )}
          {taskPayload.automationRunId && (
            <AutomationRunPill taskStore={taskStore} isConverted={taskPayload.type === 'task'} />
          )}
        </div>
      }
      rightSlot={
        <div className="flex items-center gap-2">
          <ActivityBadge projectId={projectId} taskId={taskId} />
          <PreviewServerPills />
          <OpenInMenu
            path={workspace.path}
            className="h-7 bg-transparent"
            borderless
            isRemote={isRemoteProject}
            sshConnectionId={workspace.sshConnectionId}
          />
          {/* Groups are set apart by space, not rules. */}
          <span aria-hidden className="w-1" />
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Toggle
                size="sm"
                icon
                aria-label="Toggle terminal"
                pressed={taskView.isTerminalDrawerOpen}
                onPressedChange={() => taskView.chrome.commands.toggleTerminalDrawer()}
              >
                <Terminal className="size-3.5" />
              </Toggle>
            </Tooltip.Trigger>
            <Tooltip.Content>
              Toggle terminal{' '}
              <BoundShortcut command="task.toggleTerminalDrawer" variant="keycaps" />
            </Tooltip.Content>
          </Tooltip.Root>
          <span aria-hidden className="w-1" />
          <ToggleGroup.Root
            value={taskView.isSidebarCollapsed ? [] : [taskView.sidebarTab]}
            onValueChange={([tab]) => {
              if (!tab) {
                taskView.chrome.commands.collapseSidebar();
              } else {
                taskView.chrome.commands.openSidebarTab(tab as SidebarTab);
              }
            }}
            className="bg-transparent"
          >
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <ToggleGroup.Item
                    value="changes"
                    size="sm"
                    aria-label="Changes"
                    className={cn('w-auto min-w-7 gap-0', hasDiffStats && 'px-2')}
                  >
                    <FileDiff className="size-3.5" />
                    <span
                      className={cn(
                        'overflow-hidden transition-[max-width,padding-left] duration-500 ease-in-out flex items-center tabular-nums text-xs leading-none gap-1',
                        hasDiffStats ? 'max-w-20 pl-1' : 'max-w-0 pl-0'
                      )}
                    >
                      {linesAdded > 0 && (
                        <span className="text-foreground-diff-added">
                          +{formatDiffLineCount(linesAdded)}
                        </span>
                      )}
                      {linesDeleted > 0 && (
                        <span className="text-foreground-diff-deleted">
                          -{formatDiffLineCount(linesDeleted)}
                        </span>
                      )}
                    </span>
                  </ToggleGroup.Item>
                }
              />
              <Tooltip.Content>
                Changes <BoundShortcut command="task.sidebarChanges" variant="keycaps" />
              </Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <ToggleGroup.Item size="sm" icon value="files" aria-label="Files">
                    <FolderOpen className="size-3.5" />
                  </ToggleGroup.Item>
                }
              />
              <Tooltip.Content>
                Files <BoundShortcut command="task.sidebarFiles" variant="keycaps" />
              </Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <ToggleGroup.Item size="sm" icon value="conversations" aria-label="Conversations">
                    <Clock className="size-3.5" />
                  </ToggleGroup.Item>
                }
              />
              <Tooltip.Content>
                Conversations{' '}
                <BoundShortcut command="task.sidebarConversations" variant="keycaps" />
              </Tooltip.Content>
            </Tooltip.Root>
          </ToggleGroup.Root>
        </div>
      }
    />
  );
});

function LinkedIssueBadge({ issue }: { issue: LinkedIssue }) {
  const displayIdentifier = linkedIssueDisplayIdentifier(issue);

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            disabled={!issue.url}
            onClick={() => {
              if (issue.url) void openExternal(issue.url);
            }}
            className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-foreground-muted transition-colors outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
          >
            <ProviderLogo provider={issue.provider} className="h-3 w-3" />
            {displayIdentifier ? (
              <span className="font-sans">{displayIdentifier}</span>
            ) : (
              <span className="max-w-44 truncate">{issue.title || 'Linked issue'}</span>
            )}
          </button>
        }
      />
      <Tooltip.Content>{issue.title || issue.identifier}</Tooltip.Content>
    </Tooltip.Root>
  );
}
