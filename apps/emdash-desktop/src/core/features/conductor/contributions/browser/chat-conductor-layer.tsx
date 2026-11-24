import { observer } from 'mobx-react-lite';
import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { useIsActiveTask } from '@core/features/tasks/api/browser/hooks/use-is-active-task';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';
import { sessionGlyph, StatusStrip } from '../../browser/chat-conductor/view/status-strip';
import { getChatConductorManager } from './app-stores';

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
 * A chat tab's raw view with the task conductor's status line above it. The conductor's thread
 * itself is the task strip's pinned Conductor tab (`ConductorLeadContent`); choosing a chat tab
 * always shows the chat.
 *
 * The raw view gets its own dimension provider, so terminals size to the area under the strip,
 * not to the whole pane.
 */
export const ChatConductorLayer = observer(function ChatConductorLayer({
  kind,
  conversationId,
  taskId,
  children,
}: ChatConductorLayerProps) {
  const { pane, isFocusedPane } = usePaneContext();
  const screenId = useId();
  const isActiveTask = useIsActiveTask(taskId);
  const manager = getChatConductorManager();
  const sink = useMemo(() => createPaneDimensionSink(), []);

  const kindActive =
    !pane.leadActive && pane.resolvedTabs.find((tab) => tab.isActive)?.kind === kind;
  // One conductor per task: every chat tab of the task shows the same status.
  const session = conversationId ? manager.peek(taskId) : undefined;

  // The chat tab on screen: the conductor's default chat, and where dictation goes.
  const tabOnScreen = kindActive && isActiveTask && conversationId !== undefined;
  useEffect(() => {
    manager.showOnScreen(
      screenId,
      tabOnScreen && conversationId
        ? { conversationId, taskId, focusedPane: isFocusedPane, conductor: false }
        : null
    );
  }, [manager, screenId, tabOnScreen, conversationId, taskId, isFocusedPane]);
  useEffect(() => () => manager.showOnScreen(screenId, null), [manager, screenId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {conversationId && (
        <StatusStrip
          glyph={sessionGlyph(session)}
          headline={session?.loaded ? (session.status?.headline ?? '') : ''}
          needsYou={session?.status?.state === 'needs_you'}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <PaneDimensionProvider sink={sink}>{children}</PaneDimensionProvider>
        </div>
      </div>
    </div>
  );
});
