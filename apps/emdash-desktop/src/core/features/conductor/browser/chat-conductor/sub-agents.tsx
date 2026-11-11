import { observer } from 'mobx-react-lite';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { entryForConversation } from '../roster';
import { subAgentChatSummary, taskSubAgents, type RunningSubAgents } from './sub-agent-strip';
import { helpersLine } from './view/helpers-line';

/**
 * The footer's helpers fact: one small pulsing dot and "3 helpers · Reading flow4_v2.png", or
 * only the count in a narrow pane. Nothing while no sub-agent runs. The tooltip says how the
 * helpers split across the task's chats when there are several.
 */
export function HelpersFact({ running }: { running: RunningSubAgents }) {
  const full = helpersLine(running);
  if (!full) return null;
  const count = helpersLine(typeof running === 'number' ? running : running.length) ?? full;
  const split = subAgentChatSummary(running);
  return (
    <span
      className="flex min-w-0 shrink items-center gap-1.5 motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in"
      title={split ? `${count}: ${split}` : full}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
      />
      <span className="truncate @max-[34rem]/conductor:hidden">{full}</span>
      <span className="hidden @max-[34rem]/conductor:inline">{count}</span>
    </span>
  );
}

/**
 * The helpers fact for a task's chats, in the order given, read live from the agent entries the
 * canvas keeps for them. A chat's name is its window title, as the task view's tab shows it.
 */
export const ChatHelpers = observer(function ChatHelpers({
  conversationIds,
}: {
  conversationIds: readonly string[];
}) {
  const canvas = getCanvasStore();
  const chats = conversationIds.map((id) => {
    const entry = entryForConversation(canvas, id);
    return {
      id,
      name: entry
        ? formatConversationTitleForDisplay(entry.providerId, entry.conversationTitle)
        : '',
      named: entry?.subAgents,
      waitingOn: entry?.backgroundAgents,
    };
  });
  return <HelpersFact running={taskSubAgents(chats)} />;
});
