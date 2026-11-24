import { toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useMemo } from 'react';
import { spokenProviderLabel } from '@core/features/canvas/api/provider-names';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { getConversationClaudeAccountLabel } from '@core/features/claude-accounts/contributions/browser/conversation-account';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { canIntegrateTask } from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { useIsActiveTask } from '@core/features/tasks/api/browser/hooks/use-is-active-task';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { log } from '@core/primitives/logging/browser/logger';
import { cn } from '@core/primitives/styling/browser/cn';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import type { PaneStore } from '@core/primitives/workbench-shell/browser/tabs/pane-store';
import { createTaskBrowserPort } from '../../browser/chat-conductor/browser-port';
import { ChatConductorPanel } from '../../browser/chat-conductor/chat-conductor-panel';
import { finishTask } from '../../browser/chat-conductor/view/finish-task';
import {
  ConductorStateGlyph,
  sessionGlyph,
  StatusStrip,
} from '../../browser/chat-conductor/view/status-strip';
import { entryForConversation } from '../../browser/roster';
import { getChatConductorManager, getConductorStore } from './app-stores';

/** Panes that already got their first view; the conductor leads only a pane's first showing. */
const placedPanes = new WeakSet<PaneStore>();

/**
 * The task strip's pinned first tab: the task's conductor. It has no close button, since the
 * conductor never closes, and it shows the conductor's state mark beside its name.
 */
export const ConductorLeadTab = observer(function ConductorLeadTab() {
  const { pane, isFocusedPane } = usePaneContext();
  const { taskId } = useTaskViewContext();
  const manager = getChatConductorManager();
  const active = pane.leadActive;
  const glyph = sessionGlyph(manager.peek(taskId));

  // A pane opened while conductors can run starts on the conductor, as a chat's view did before.
  useEffect(() => {
    if (placedPanes.has(pane)) return;
    placedPanes.add(pane);
    if (manager.ready) pane.setLeadActive(true);
    // Only the pane's first showing decides; later the developer's choice stands.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  return (
    <button
      type="button"
      title="Conductor"
      data-active={active || undefined}
      aria-pressed={active}
      onClick={() => pane.setLeadActive(true)}
      className={cn(
        // The look of a tab chip (`GenericTabItem`) without its close button.
        'group relative flex h-[33px] cursor-pointer items-center gap-1.5 rounded-t-md px-3 text-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
        active
          ? cn(
              'bg-(--em-surface-paper)',
              isFocusedPane ? 'text-foreground' : 'text-foreground-muted'
            )
          : 'text-foreground-passive hover:text-foreground-muted'
      )}
    >
      {glyph && <ConductorStateGlyph glyph={glyph} />}
      <span className="truncate">Conductor</span>
    </button>
  );
});

/**
 * What the pinned Conductor tab shows: the conductor's status line and its thread with the
 * developer. The chats' raw views stay mounted under it in their own tabs.
 */
export const ConductorLeadContent = observer(function ConductorLeadContent() {
  const { pane, isFocusedPane } = usePaneContext();
  const { projectId, taskId } = useTaskViewContext();
  const screenId = useId();
  const taskView = useTaskComposition();
  const isActiveTask = useIsActiveTask(taskId);
  const openIntegrate = useOpenModal('integrateWorktreeModal');
  const manager = getChatConductorManager();
  const browsers = useMemo(() => createTaskBrowserPort(getCanvasStore(), taskId), [taskId]);
  const ready = manager.ready;
  const session = manager.peek(taskId);

  // A conductor exists once its view was shown; a task never opened this way costs nothing.
  useEffect(() => {
    manager.session(taskId);
  }, [manager, taskId]);

  // The chat the conductor speaks about by default: the one whose tab was last on screen.
  const chatId = manager.lastChatOnScreen(taskId) ?? session?.chatIds[0];
  /** The developer is looking at the conductor's thread right now. */
  const onScreen = isActiveTask;

  // With the thread in front, the HUD's typed box and voice commands address this conductor.
  useEffect(() => {
    manager.showOnScreen(
      screenId,
      onScreen && chatId
        ? { conversationId: chatId, taskId, focusedPane: isFocusedPane, conductor: true }
        : null
    );
  }, [manager, screenId, onScreen, chatId, taskId, isFocusedPane]);
  useEffect(() => () => manager.showOnScreen(screenId, null), [manager, screenId]);

  // It starts following the chats the first time the developer actually sees the thread.
  useEffect(() => {
    if (onScreen && ready && session) void session.attach();
  }, [onScreen, ready, session]);

  // What the footer can say about that chat, all read from stores already in memory.
  const chat = chatId ? entryForConversation(getCanvasStore(), chatId) : undefined;
  const accountLabel =
    chat && chatId
      ? getConversationClaudeAccountLabel({
          providerId: chat.providerId,
          claudeAccountId: conversationRegistry.get(taskId)?.conversations.get(chatId)?.data
            .claudeAccountId,
        })
      : null;
  const task = getTaskStore(projectId, taskId);

  // Archiving is reversible, so it asks nothing. It leaves for the task's project by itself once it
  // succeeded and this task is the one on screen; when it fails, the view stays and says so.
  const onDone = () => {
    const taskManager = getTaskManagerStore(projectId);
    return finishTask(taskManager ? () => taskManager.archiveTask(taskId) : null, (error) => {
      log.warn('chat conductor: the task could not be archived', { error });
      toast.error('Could not archive the task');
    });
  };
  const onMerge = canIntegrateTask(projectId, taskId)
    ? () => void openIntegrate({ projectId, taskId })
    : null;
  const onOpenApp = (url: string) => {
    try {
      browsers.open(url);
    } catch (error) {
      log.warn('chat conductor: the app could not be opened', { error });
    }
  };
  // "Open the agent" in the thread: the pane's chat tab, which shows the raw chat.
  const onShowRaw = () => {
    const id = pane.resolvedActiveTabId;
    if (!id) return;
    pane.setActiveTab(id);
    pane.focusActiveContent();
  };

  return (
    <div className="surface-paper flex h-full min-h-0 flex-col bg-surface">
      <StatusStrip
        glyph={sessionGlyph(session)}
        headline={session?.loaded ? (session.status?.headline ?? '') : ''}
        needsYou={session?.status?.state === 'needs_you'}
      />
      <div className="relative min-h-0 flex-1">
        {session && (
          <ChatConductorPanel
            session={session}
            ready={ready}
            enabled={manager.enabled}
            autoFocus={onScreen && taskView.focusedRegion === 'main'}
            onFocus={() => {
              if (isActiveTask) taskView.setFocusedRegion('main');
              manager.touchScreen(screenId);
            }}
            onShowRaw={onShowRaw}
            onDone={onDone}
            onMerge={onMerge}
            onOpenApp={onOpenApp}
            devServerOrigins={browsers.devServerOrigins()}
            providerLabel={chat ? spokenProviderLabel(chat.providerId) : null}
            accountLabel={accountLabel}
            conductorEffort={getConductorStore().status?.settings?.chatConductorEffort ?? null}
            diffStat={task ? <TaskGitDiffStats task={task} /> : null}
          />
        )}
      </div>
    </div>
  );
});
