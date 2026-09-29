import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { AgentTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import { ChatTranscript } from '@core/features/conversations/api/browser/chat/chat-transcript';
import {
  getAcpChatResourceManager,
  type AcpChatStore,
} from '@core/features/conversations/contributions/browser/acp-chat';
import { cn } from '@core/primitives/styling/browser/cn';
import { TerminalPlaceholder } from './agent-terminal';

/**
 * Live ACP transcript in a canvas tile. Reuses the shared AcpChatStore so the task
 * view and canvas do not duplicate session attach. No composer: click-to-focus at
 * overview zoom; at zoom 1 the transcript is readable.
 */
export const AgentAcpLive = observer(function AgentAcpLive({
  entry,
  interactive,
  onActivate,
}: {
  entry: AgentTileEntry;
  interactive: boolean;
  onActivate: () => void;
}) {
  const { taskId, projectId, conversationId } = entry;
  const [store, setStore] = useState<AcpChatStore | null>(null);

  useEffect(() => {
    const manager = getAcpChatResourceManager(taskId, projectId);
    const acquired = manager.acquire(conversationId);
    acquired.bootstrap();
    setStore(acquired);
    return () => {
      manager.release(conversationId);
      setStore(null);
    };
  }, [taskId, projectId, conversationId]);

  if (!store) return <TerminalPlaceholder label="Attaching to agent…" />;

  return (
    <div className={cn('relative h-full min-h-0', interactive && 'nodrag nowheel')}>
      <ChatTranscript
        context={store.chatContext}
        state={store.chatState}
        stickToBottom
        className="h-full"
        style={{ position: 'absolute', inset: 0 }}
      />
      {!interactive && (
        <button
          type="button"
          aria-label="Focus this agent"
          className="absolute inset-0 z-10 cursor-zoom-in bg-transparent"
          onClick={onActivate}
        />
      )}
    </div>
  );
});
