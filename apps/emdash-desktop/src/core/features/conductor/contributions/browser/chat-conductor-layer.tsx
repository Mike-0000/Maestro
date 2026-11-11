import { Badge, ToggleGroup, type BadgeTone } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useIsActiveTask } from '@core/features/tasks/api/browser/hooks/use-is-active-task';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { cn } from '@core/primitives/styling/browser/cn';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@core/primitives/workbench-shell/browser/tabs/pane-dimension-provider';
import type { ChatConductorState, ChatConductorStatus } from '../../api/chat-conductor/thread';
import { ChatConductorPanel } from '../../browser/chat-conductor/chat-conductor-panel';
import { useChatViewChoice } from '../../browser/chat-conductor/use-chat-view-choice';
import type { ChatView } from '../mementos';
import { getChatConductorManager } from './app-stores';

const STATE_LABELS: Record<ChatConductorState, string> = {
  idle: 'Idle',
  working: 'Working',
  needs_you: 'Needs you',
  done: 'Done',
};

const STATE_TONES: Record<ChatConductorState, BadgeTone> = {
  idle: 'neutral',
  working: 'info',
  needs_you: 'warning',
  done: 'success',
};

/** The conductor's one-line status: what the developer reads before anything else. */
function StatusLine({ status }: { status: ChatConductorStatus | null }) {
  if (!status) return <span className="min-w-0 flex-1" />;
  const needsYou = status.state === 'needs_you';
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" role="status">
      <Badge variant={needsYou ? 'soft' : 'outline'} tone={STATE_TONES[status.state]}>
        {STATE_LABELS[status.state]}
      </Badge>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-xs',
          needsYou ? 'font-medium text-foreground' : 'text-foreground-muted'
        )}
        title={status.headline}
      >
        {status.headline}
      </span>
    </span>
  );
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
 * Conductor | Raw switch, and under it the thread with the conductor or the raw chat.
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
  const { pane } = usePaneContext();
  const taskView = useTaskComposition();
  const isActiveTask = useIsActiveTask(taskId);
  const manager = getChatConductorManager();
  const sink = useMemo(() => createPaneDimensionSink(), []);
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
  const session = conversationId ? manager.peek(conversationId) : undefined;

  // A conductor exists once its view was shown; a chat never opened this way costs nothing.
  useEffect(() => {
    if (chosen === 'conductor' && conversationId) manager.session(conversationId);
  }, [chosen, conversationId, manager]);

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

  const rawShown = !showsConductor;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {conversationId && (
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-(--em-surface) px-2">
          <StatusLine status={session?.status ?? null} />
          <ToggleGroup.Root
            multiple={false}
            value={[view]}
            aria-label="Chat view"
            onValueChange={([value]) => {
              if (value === 'conductor' || value === 'raw') setView(value);
            }}
          >
            <ToggleGroup.Item size="sm" value="conductor" className="text-xs">
              Conductor
            </ToggleGroup.Item>
            <ToggleGroup.Item size="sm" value="raw" className="text-xs">
              Raw
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
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
          <div className="absolute inset-0">
            <ChatConductorPanel
              key={conversationId}
              session={session}
              ready={ready}
              enabled={manager.enabled}
              autoFocus={onScreen && taskView.focusedRegion === 'main'}
              onFocus={() => {
                if (isActiveTask) taskView.setFocusedRegion('main');
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
});
