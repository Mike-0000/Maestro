import { toast } from '@emdash/ui/react/primitives';
import { MessageSquareIcon } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { projectData } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { openTaskConversation } from '@core/features/workbench/api/browser/task-composition-selectors';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { useWorkspaceGroups } from '@core/features/workspaces/api/browser/use-workspace-groups';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import type { HostUnlinkedConversation } from '@core/primitives/workspaces/api';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

/**
 * Keeps the sidebar store supplied with each machine's conversations that no task on this
 * client is linked to, one live subscription per machine that has a project here.
 */
export const SidebarHostConversationsSync = observer(function SidebarHostConversationsSync() {
  const machineIds = new Set<string>();
  for (const project of getSidebarStore().orderedProjects) {
    const data = projectData(project);
    if (data?.type === 'ssh') machineIds.add(data.connectionId);
  }
  return (
    <>
      {[...machineIds].map((machineId) => (
        <MachineHostConversationsSync key={machineId} machineId={machineId} />
      ))}
    </>
  );
});

function MachineHostConversationsSync({ machineId }: { machineId: string }) {
  const groups = useWorkspaceGroups({ kind: 'machine', machineId }, true).data;

  useEffect(() => {
    if (!groups) return;
    getSidebarStore().setHostConversations(
      machineId,
      new Map(groups.map((group) => [group.project.id, group.unlinkedConversations ?? []]))
    );
  }, [groups, machineId]);

  useEffect(() => () => getSidebarStore().setHostConversations(machineId, undefined), [machineId]);

  return null;
}

/**
 * A conversation that exists on the project's machine but in no task on this client, for example
 * one started from another computer. Clicking it offers to resume it here, which opens it in a
 * new task on the workspace it ran in; the row then gives way to that task.
 */
export const SidebarHostConversationItem = observer(function SidebarHostConversationItem({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const { navigate } = useNavigate();
  const openConfirm = useOpenModal('confirmActionModal');
  const [busy, setBusy] = useState(false);
  const conversation = getSidebarStore().hostConversation(projectId, conversationId);
  if (!conversation) return null;
  const title = conversation.title || 'Untitled conversation';

  const resume = async () => {
    if (busy) return;
    if (conversation.resumeDisabledReason || !conversation.workspaceId) {
      toast.error('Could not resume conversation', {
        description: conversation.resumeDisabledReason ?? 'This workspace is not registered.',
      });
      return;
    }
    const outcome = await openConfirm({
      title: 'Resume this conversation here?',
      description: `“${title}” was started on this machine from another computer. Resuming opens it in a new task in this project.`,
      confirmLabel: 'Resume here',
      variant: 'default',
    });
    if (!outcome.success) return;
    setBusy(true);
    try {
      const taskId = await resumeHostConversation(
        projectId,
        conversation,
        conversation.workspaceId
      );
      navigate(taskViewDef({ projectId, taskId }));
    } catch (error) {
      toast.error('Could not resume conversation', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidebarMenuRow
      className={cn(
        'group/row flex h-8 items-center justify-between gap-1 px-1 py-1.5 pl-8',
        busy && 'opacity-60'
      )}
      title={`${title} · ${conversation.workspacePath}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void resume()}
    >
      <SidebarMenuAction
        aria-label={`Resume conversation ${title}`}
        className="gap-1.5 overflow-hidden"
      >
        <MessageSquareIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 truncate text-left italic">{title}</span>
      </SidebarMenuAction>
      <span className="ml-2 shrink-0 pr-1 text-xs text-foreground-passive">
        {busy ? 'Resuming…' : 'Resume'}
      </span>
    </SidebarMenuRow>
  );
});

/** Creates a task on the conversation's workspace, links the conversation to it, and opens it. */
async function resumeHostConversation(
  projectId: string,
  conversation: HostUnlinkedConversation,
  workspaceId: string
): Promise<string> {
  const taskManager = getTaskManagerStore(projectId);
  if (!taskManager) throw new Error('The project for this workspace is not open.');
  const taskId = crypto.randomUUID();
  await taskManager.createTask({
    id: taskId,
    projectId,
    taskConfig: { version: '1', name: conversation.title || 'Continued conversation' },
    workspaceConfig: {
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId },
    },
  });
  const client = await getConversationsClient();
  await client.linkConversationToTask({ conversationId: conversation.id, projectId, taskId });
  void openTaskConversation(projectId, taskId, conversation.id);
  return taskId;
}
