import { toast } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
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
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';
import { createTaskBrowserPort } from '../../browser/chat-conductor/browser-port';
import { ChatConductorPanel } from '../../browser/chat-conductor/chat-conductor-panel';
import type { ChatConductorSession } from '../../browser/chat-conductor/session';
import { useChatViewChoice } from '../../browser/chat-conductor/use-chat-view-choice';
import { finishTask } from '../../browser/chat-conductor/view/finish-task';
import { StatusStrip, type ConductorGlyph } from '../../browser/chat-conductor/view/status-strip';
import { conductorVitals } from '../../browser/chat-conductor/view/vitals';
import { entryForConversation } from '../../browser/roster';
import type { ChatView } from '../mementos';
import { getChatConductorManager, getConductorStore } from './app-stores';

/**
 * The strip's mark: the same one the footer shows, or none before there is anything to report
 * (no thread yet, still loading, or nothing in it and nothing running).
 */
function stripGlyph(session: ChatConductorSession | undefined): ConductorGlyph | null {
  if (!session?.loaded) return null;
  const last = session.entries.at(-1) ?? null;
  if (!last && !session.busy && !session.status) return null;
  return conductorVitals({
    state: session.status?.state ?? null,
    busy: session.busy,
    activity: null,
    busySinceMs: null,
    lastEntryAt: last?.at ?? null,
    lastEntryKind: last?.kind ?? null,
    nowMs: 0,
    providerLabel: null,
    accountLabel: null,
    conductorEffort: null,
  }).glyph;
}

export interface ChatConductorLayerProps {
  /** The tab kind this layer wraps; it shows only while a tab of that kind is the active one. */
  kind: string;
  /** The active chat of that kind, if any. */
  conversationId: string | undefined;
  taskId: string;
  /** The raw view: the terminal or the ACP chat, exactly as it works without a conductor. */
  children: ReactNode;
}

/**
 * Puts a chat's conductor in front of the chat itself: a strip with the conductor's status and a
 * Conductor | Raw switch, and under it the thread with the conductor or the raw chat, all on one
 * reading surface.
 *
 * The raw view stays mounted while the thread shows, hidden the way `PaneContent` hides inactive
 * tab kinds, because PTY sessions and their terminals live in it. It gets its own dimension
 * provider, so terminals size to the area under the strip, not to the whole pane.
 */
export const ChatConductorLayer = observer(function ChatConductorLayer({
  kind,
  conversationId,
  taskId,
  children,
}: ChatConductorLayerProps) {
  const { pane, isFocusedPane } = usePaneContext();
  const screenId = useId();
  const taskView = useTaskComposition();
  const { projectId } = useTaskViewContext();
  const isActiveTask = useIsActiveTask(taskId);
  const openIntegrate = useOpenModal('integrateWorktreeModal');
  const manager = getChatConductorManager();
  const sink = useMemo(() => createPaneDimensionSink(), []);
  const browsers = useMemo(() => createTaskBrowserPort(getCanvasStore(), taskId), [taskId]);
  const choice = useChatViewChoice(conversationId);
  const ready = manager.ready;

  // While a chat's remembered choice is read, the view on screen stays as it was.
  const lastView = useRef<ChatView | null>(null);
  const chosen: ChatView | null = choice
    ? (choice.value.view ?? (ready ? 'conductor' : 'raw'))
    : null;
  const view: ChatView = !conversationId
    ? 'raw'
    : (chosen ?? lastView.current ?? (ready ? 'conductor' : 'raw'));
  useEffect(() => {
    if (chosen) lastView.current = chosen;
  }, [chosen]);

  const kindActive = pane.resolvedTabs.find((tab) => tab.isActive)?.kind === kind;
  const showsConductor = view === 'conductor' && conversationId !== undefined;
  /** The developer is looking at this chat's thread right now. */
  const onScreen = chosen === 'conductor' && kindActive && isActiveTask;
  // One conductor per task: every chat tab of the task shows the same thread.
  const session = conversationId ? manager.peek(taskId) : undefined;

  // A conductor exists once its view was shown; a task never opened this way costs nothing.
  useEffect(() => {
    if (chosen === 'conductor' && conversationId) manager.session(taskId);
  }, [chosen, conversationId, manager, taskId]);

  // The chat tab on screen: the conductor's default chat, and with its Conductor view in front,
  // what the HUD's typed box and voice commands address (dictation goes to its agent).
  const tabOnScreen = kindActive && isActiveTask && conversationId !== undefined;
  useEffect(() => {
    manager.showOnScreen(
      screenId,
      tabOnScreen && conversationId
        ? { conversationId, taskId, focusedPane: isFocusedPane, conductor: chosen === 'conductor' }
        : null
    );
  }, [manager, screenId, tabOnScreen, conversationId, taskId, isFocusedPane, chosen]);
  useEffect(() => () => manager.showOnScreen(screenId, null), [manager, screenId]);

  // It starts following the chat the first time the developer actually sees the thread.
  useEffect(() => {
    if (onScreen && ready && session) void session.attach();
  }, [onScreen, ready, session]);

  const setView = (next: ChatView) => {
    if (!choice || next === view) return;
    choice.update((current) => ({ ...current, view: next }));
    // The raw view takes the keyboard back; the thread focuses its own composer.
    if (next === 'raw') pane.focusActiveContent();
  };

  // What the footer can say about the chat on screen, all read from stores already in memory.
  const chat = conversationId ? entryForConversation(getCanvasStore(), conversationId) : undefined;
  const accountLabel =
    chat && conversationId
      ? getConversationClaudeAccountLabel({
          providerId: chat.providerId,
          claudeAccountId: conversationRegistry.get(taskId)?.conversations.get(conversationId)?.data
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

  const rawShown = !showsConductor;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {conversationId && (
        <StatusStrip
          glyph={stripGlyph(session)}
          headline={session?.loaded ? (session.status?.headline ?? '') : ''}
          needsYou={session?.status?.state === 'needs_you'}
          view={view}
          onViewChange={setView}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div
          className="absolute inset-0"
          // Never an explicit `visible`: PaneContent hides an inactive tab kind with
          // `visibility: hidden` on an ancestor, and an explicit value here would override it,
          // leaving this box painted over the active kind and taking its clicks.
          style={rawShown ? undefined : { visibility: 'hidden' }}
          inert={rawShown ? undefined : true}
        >
          <PaneDimensionProvider sink={sink}>{children}</PaneDimensionProvider>
        </div>
        {showsConductor && session && (
          <div className="surface-paper absolute inset-0 bg-surface">
            <ChatConductorPanel
              key={conversationId}
              session={session}
              ready={ready}
              enabled={manager.enabled}
              autoFocus={onScreen && taskView.focusedRegion === 'main'}
              onFocus={() => {
                if (isActiveTask) taskView.setFocusedRegion('main');
                manager.touchScreen(screenId);
              }}
              onShowRaw={() => setView('raw')}
              onDone={onDone}
              onMerge={onMerge}
              onOpenApp={onOpenApp}
              devServerOrigins={browsers.devServerOrigins()}
              providerLabel={chat ? spokenProviderLabel(chat.providerId) : null}
              accountLabel={accountLabel}
              conductorEffort={getConductorStore().status?.settings?.chatConductorEffort ?? null}
              diffStat={task ? <TaskGitDiffStats task={task} /> : null}
            />
          </div>
        )}
      </div>
    </div>
  );
});
