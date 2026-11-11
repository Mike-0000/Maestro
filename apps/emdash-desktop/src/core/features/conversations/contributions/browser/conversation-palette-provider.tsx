import { Command } from 'cmdk';
import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import type { ConversationStore } from '@core/features/conversations/api/browser/conversation-manager';
import { formatConversationTitleForDisplay } from '@core/features/conversations/api/browser/conversation-title-utils';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { ConversationStateGlyph } from '@core/features/conversations/browser/conversation-state-glyph';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import {
  type PaletteProviderDef,
  type PaletteProviderRenderProps,
} from '@core/primitives/palette/api';
import { PALETTE_ITEM_CLASS } from '@core/primitives/palette/browser/palette-item-styles';
import {
  conversationPaletteSource,
  type ConversationPaletteMatch,
} from './conversation-palette-source';

const ConversationPaletteItem = observer(function ConversationPaletteItem({
  conversation,
  value,
  onSelect,
}: {
  conversation: ConversationStore;
  value: string;
  onSelect: () => void;
}) {
  const title = formatConversationTitleForDisplay(
    conversation.data.providerId,
    conversation.data.title ?? ''
  );
  return (
    <Command.Item value={value} onSelect={onSelect} className={PALETTE_ITEM_CLASS}>
      <AgentIcon id={conversation.data.providerId} size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <ConversationStateGlyph status={conversation.indicatorStatus} className="flex shrink-0" />
    </Command.Item>
  );
});

function ConversationPaletteProviderRow({
  match,
  value,
  onSelect,
}: PaletteProviderRenderProps<ConversationPaletteMatch>) {
  const { navigate } = useNavigate();
  const { item } = match;
  const conversation = conversationRegistry.get(item.taskId)?.conversations.get(item.id);
  const handleSelect = () => {
    getTaskComposition(item.projectId, item.taskId)?.paneLayout.open(
      'conversation',
      { conversationId: item.id },
      { preview: false }
    );
    onSelect();
    navigate(taskViewDef({ projectId: item.projectId, taskId: item.taskId }));
  };

  if (conversation) {
    return (
      <ConversationPaletteItem conversation={conversation} value={value} onSelect={handleSelect} />
    );
  }
  return (
    <Command.Item value={value} onSelect={handleSelect} className={PALETTE_ITEM_CLASS}>
      <MessageSquare className="size-4 shrink-0 text-foreground-passive" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
    </Command.Item>
  );
}

const typedConversationPaletteProviderDef: PaletteProviderDef<
  'conversations',
  ConversationPaletteMatch
> = {
  kind: 'conversations',
  keyword: '@conversations',
  minQueryLength: 1,
  idle: conversationPaletteSource.idle,
  search: conversationPaletteSource.search,
  render: ConversationPaletteProviderRow,
};

export const conversationPaletteProviderDef: PaletteProviderDef = {
  ...typedConversationPaletteProviderDef,
  render: ({ match, value, onSelect }) => (
    <ConversationPaletteProviderRow
      match={match as ConversationPaletteMatch}
      value={value}
      onSelect={onSelect}
    />
  ),
};

export const conversationsPaletteProviderDefs = [conversationPaletteProviderDef] as const;
