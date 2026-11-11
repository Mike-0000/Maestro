import { STATE_GLYPH_LABELS, StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { Command } from 'cmdk';
import { GitBranch, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { taskAgentStatus } from '@core/features/conversations/api/browser/conversation-selectors';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import type { PaletteProviderRenderProps } from '@core/primitives/palette/api';
import { PALETTE_ITEM_CLASS } from '@core/primitives/palette/browser/palette-item-styles';
import type { TaskPaletteMatch } from './task-palette-provider';

const STATE_FOR_STATUS: Record<Exclude<AgentStatus, 'idle'>, StateGlyphState> = {
  'awaiting-input': 'needs-you',
  working: 'working',
  completed: 'unread',
  error: 'error',
};

/**
 * The shared state mark (design brief 2.6) for an agent status; nothing while idle. The
 * wrapper keeps the status on `data-status` for tests and styling hooks.
 */
function PaletteStateMark({ status }: { status: AgentStatus | null | undefined }) {
  if (!status || status === 'idle') return null;
  const state = STATE_FOR_STATUS[status];
  if (!state) return null;
  return (
    <span data-status={status} className="flex shrink-0">
      <StateGlyph state={state} />
      <span className="sr-only">{STATE_GLYPH_LABELS[state]}</span>
    </span>
  );
}

export const TaskPaletteRow = observer(function TaskPaletteRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<TaskPaletteMatch>) {
  const { navigate } = useNavigate();
  const { target } = match;

  const handleSelect = () => {
    if (target.kind === 'task') {
      onSelect();
      navigate(taskViewDef({ projectId: target.projectId, taskId: target.taskId }));
      return;
    }

    getTaskComposition(target.projectId, target.taskId)?.paneLayout.open(
      'conversation',
      { conversationId: target.conversationId },
      { preview: false }
    );
    onSelect();
    if (!target.keepCurrentTask) {
      navigate(taskViewDef({ projectId: target.projectId, taskId: target.taskId }));
    }
  };

  if (target.kind === 'task') {
    const taskStore = getTaskStore(target.projectId, target.taskId);
    if (taskStore) {
      return (
        <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
          <GitBranch className="size-4 shrink-0 text-foreground-passive" />
          <span className="min-w-0 flex-1 truncate">{taskStore.data.name}</span>
          <PaletteStateMark status={taskAgentStatus(taskStore)} />
        </Command.Item>
      );
    }
  } else {
    const conversation = conversationRegistry
      .get(target.taskId)
      ?.conversations.get(target.conversationId);
    if (conversation) {
      return (
        <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
          <AgentIcon id={conversation.data.providerId} size={16} />
          <span className="min-w-0 flex-1 truncate">
            {formatConversationTitleForDisplay(
              conversation.data.providerId,
              conversation.data.title ?? ''
            )}
          </span>
          <PaletteStateMark status={conversation.indicatorStatus} />
        </Command.Item>
      );
    }
  }

  const Icon = target.kind === 'task' ? GitBranch : MessageSquare;
  return (
    <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
      <Icon className="size-4 shrink-0 text-foreground-passive" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{match.title}</span>
        {match.subtitle && (
          <span className="truncate text-xs text-foreground-passive">{match.subtitle}</span>
        )}
      </span>
    </Command.Item>
  );
});
