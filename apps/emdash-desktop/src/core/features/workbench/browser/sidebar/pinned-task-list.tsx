import { observer } from 'mobx-react-lite';
import { getSidebarStore } from '@core/features/workbench/contributions/browser/app-stores';
import { SidebarGroup, SidebarMenu, SidebarSectionLabel } from './sidebar-primitives';
import { SidebarTaskItem } from './task-item';

export const SidebarPinnedTaskList = observer(function SidebarPinnedTaskList() {
  const entries = getSidebarStore().pinnedSidebarEntries;
  if (entries.length === 0) return null;

  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col">
      <div className="flex h-8 items-center justify-between pr-2.5 pl-5">
        <SidebarSectionLabel>Pinned</SidebarSectionLabel>
      </div>
      <SidebarMenu className="px-3">
        {entries.map(({ projectId, taskId }) => (
          <SidebarTaskItem
            key={`${projectId}:${taskId}`}
            projectId={projectId}
            taskId={taskId}
            rowVariant="pinned"
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
});
