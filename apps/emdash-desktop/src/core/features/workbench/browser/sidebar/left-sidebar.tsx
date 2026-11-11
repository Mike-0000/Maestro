import { Clock, FolderInput, LayoutDashboard, MessageSquareShare, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { automationsViewDef } from '@core/features/automations/contributions/views';
import { canvasViewDef } from '@core/features/canvas/contributions/views';
import { ClaudeUsageIndicator } from '@core/features/claude-accounts/contributions/browser/claude-usage-indicator';
import { ConductorOwnershipLine } from '@core/features/conductor/contributions/browser/conductor-ownership-line';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';
import { WORKBENCH_BOTTOM_BAR_HEIGHT_PX } from '@core/primitives/layouts/api/workbench-layout';
import {
  isCurrentView,
  useNavigate,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { SidebarPinnedTaskList } from './pinned-task-list';
import { ProjectsGroupLabel } from './projects-group-label';
import {
  SidebarContainer,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
} from './sidebar-primitives';
import { SidebarSearchTrigger } from './sidebar-search-trigger';
import { SidebarSpace } from './sidebar-space';
import { SidebarVirtualList } from './sidebar-virtual-list';
import { UpdateSection } from './update-section';
import { useSidebarDrop } from './use-sidebar-drop';

export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();

  const openFeedbackModal = useOpenModal('feedbackModal');
  const { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop } = useSidebarDrop();

  return (
    <div
      className={cn(
        // The sunken surface alone sets the sidebar apart from the content: no edge line. The
        // title bar and tab strip sit on the same surface, so the chrome reads as one piece.
        'surface-sunken relative flex h-full flex-col bg-(--em-surface) text-foreground-muted transition-colors',
        isDragOver && 'ring-1 ring-ring ring-inset'
      )}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-(--em-surface)/85 backdrop-blur-sm">
          <FolderInput className="size-6 text-foreground-muted" />
          <span className="text-sm text-foreground">Drop to add project</span>
        </div>
      )}
      <SidebarSpace />
      <SidebarContainer className="min-h-0 w-full flex-1">
        <SidebarContent className="flex flex-col">
          <ConductorOwnershipLine className="shrink-0 px-5 pt-1 pb-3" />
          <SidebarPinnedTaskList />
          <SidebarGroup className="mb-0 flex min-h-0 flex-1 flex-col">
            <ProjectsGroupLabel />
            <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
              <SidebarMenu className="flex min-h-0 flex-1 flex-col">
                <SidebarVirtualList />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarSearchTrigger />
            <SidebarMenuButton
              isActive={isCurrentView(currentView, 'canvas')}
              onClick={() => navigate(canvasViewDef())}
              aria-label="Canvas"
              className="w-full justify-between"
            >
              <span className="flex min-w-0 items-center gap-2">
                <LayoutDashboard className="size-4 shrink-0" />
                <span className="truncate">Canvas</span>
              </span>
            </SidebarMenuButton>
            <SidebarMenuButton
              isActive={isCurrentView(currentView, 'automations')}
              onClick={() => navigate(automationsViewDef())}
              aria-label="Automations"
              className="w-full justify-between"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Clock className="size-4 shrink-0" />
                <span className="truncate">Automations</span>
              </span>
            </SidebarMenuButton>
            <ClaudeUsageIndicator
              trigger={<SidebarMenuButton className="w-full justify-between" />}
            />
            <SidebarMenuButton
              isActive={isCurrentView(currentView, 'settings')}
              onClick={() => navigate(settingsViewDef())}
              aria-label="Settings"
              className="w-full justify-between"
            >
              <span className="flex items-center gap-2">
                <Settings className="size-4 shrink-0" />
                Settings
              </span>
              <BoundShortcut command="app.settings" variant="keycaps" />
            </SidebarMenuButton>
          </SidebarMenu>
        </SidebarFooter>
        <div
          className="flex shrink-0 items-center justify-between gap-2 px-3"
          style={{ height: WORKBENCH_BOTTOM_BAR_HEIGHT_PX }}
        >
          <button
            type="button"
            className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground-passive transition-colors hover:bg-(--em-surface-hover) hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => void openFeedbackModal({})}
          >
            <MessageSquareShare className="size-3.5 shrink-0" />
            <span className="truncate">Give feedback</span>
          </button>
          <UpdateSection />
        </div>
      </SidebarContainer>
    </div>
  );
});
