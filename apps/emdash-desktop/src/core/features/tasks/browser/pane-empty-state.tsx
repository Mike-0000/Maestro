import { FileSearch, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { useWorkspaceId } from '@core/features/workbench/api/browser/task-composition-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { useArrowKeyNavigation } from '@core/primitives/react-hooks/browser/use-arrow-key-navigation';
import { cn } from '@core/primitives/styling/browser/cn';
import { usePaneContext } from '@core/primitives/workbench-shell/browser/tabs/pane-context';

export function PaneEmptyState() {
  const { projectId, taskId } = useTaskViewContext();
  const workspaceId = useWorkspaceId();
  const { pane } = usePaneContext();
  const openCreateConversationModal = useOpenModal('createConversationModal');
  const openCommandPalette = useOpenModal('commandPaletteModal');

  const actions = [
    () => {
      void (async () => {
        const outcome = await openCreateConversationModal({ projectId, taskId });
        if (!outcome.success) return;
        const { conversationId, type } = outcome.data;
        if (type === 'acp') {
          pane.open('acp-chat', { conversationId, preview: false });
        } else {
          pane.open('conversation', { conversationId, preview: false });
        }
      })();
    },
    () => {
      void openCommandPalette({ projectId, taskId, workspaceId });
    },
  ];

  const { selectedIndex, setSelectedIndex } = useArrowKeyNavigation(actions.length, (index) =>
    actions[index]()
  );

  // The empty pane (design brief 2.12): a quiet title and one sentence, then the two ways to
  // fill it as menu-like rows with their shortcuts. Arrow keys move between them.
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="mb-5 flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium text-foreground">Nothing open here</p>
        <p className="text-xs text-foreground-muted">Start a conversation or open a file.</p>
      </div>
      <div className="flex w-full max-w-72 flex-col gap-0.5">
        <PaneEmptyStateAction
          isSelected={selectedIndex === 0}
          onMouseEnter={() => setSelectedIndex(0)}
          onClick={actions[0]}
          icon={<MessageSquare className="size-4" />}
          label="New conversation"
          commandId="task.newConversation"
        />
        <PaneEmptyStateAction
          isSelected={selectedIndex === 1}
          onMouseEnter={() => setSelectedIndex(1)}
          onClick={actions[1]}
          icon={<FileSearch className="size-4" />}
          label="Open file"
          commandId="app.commandPalette"
        />
      </div>
    </div>
  );
}

function PaneEmptyStateAction({
  icon,
  label,
  commandId,
  isSelected,
  onClick,
  onMouseEnter,
}: {
  icon: ReactNode;
  label: string;
  commandId: string;
  isSelected?: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'flex h-8 items-center justify-between gap-3 rounded-md px-2.5 text-sm text-foreground-muted transition-colors outline-none',
        'hover:bg-surface-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        isSelected && 'bg-surface-hover text-foreground'
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-foreground-passive">{icon}</span>
        {label}
      </span>
      <BoundShortcut command={commandId} variant="keycaps" />
    </button>
  );
}
