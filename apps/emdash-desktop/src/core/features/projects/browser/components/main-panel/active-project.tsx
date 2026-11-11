import { getPillTabId } from '@emdash/ui/react/patterns';
import { Tabs } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import {
  asAvailableProject,
  getProjectStore,
  getProjectViewStore,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { PullRequestView } from '@core/features/projects/browser/components/pr-view/pr-view';
import { SettingsPanel } from '@core/features/projects/browser/components/settings-view/settings-panel';
import { TaskList } from '@core/features/projects/browser/components/task-view/task-list';
import { ProjectWorkspacesView } from '@core/features/projects/browser/components/workspaces-view/project-workspaces-view';
import type { ProjectView } from '@core/features/projects/browser/stores/project-view';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useCurrentViewParams } from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';

const PROJECT_SECTION_PANEL_ID = 'project-section-panel';

const PROJECT_SECTIONS: readonly { value: ProjectView; label: string }[] = [
  { value: 'tasks', label: 'Tasks' },
  { value: 'pull-request', label: 'Pull requests' },
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'settings', label: 'Settings' },
];

export const ActiveProject = observer(function ActiveProject() {
  const {
    params: { projectId },
  } = useCurrentViewParams(projectViewDef);
  const context = asAvailableProject(getProjectStore(projectId));
  const view = getProjectViewStore(projectId);

  if (!context || !view) return null;

  const activeView = view.activeView;
  return (
    <div className="flex min-h-0 w-full flex-col gap-5">
      {/* Plain words with an underline under the one on screen; no segmented bar, no icons. */}
      <Tabs.Root
        value={activeView}
        onValueChange={(next) => {
          if (next != null) view.setProjectView(next as ProjectView);
        }}
      >
        <Tabs.List
          variant="underline"
          aria-label="Project sections"
          activateOnFocus
          className="-ml-2"
        >
          {PROJECT_SECTIONS.map((section) => (
            <Tabs.Tab
              key={section.value}
              value={section.value}
              size="sm"
              id={getPillTabId(PROJECT_SECTION_PANEL_ID, section.value)}
              aria-controls={PROJECT_SECTION_PANEL_ID}
            >
              {section.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <section
        role="tabpanel"
        id={PROJECT_SECTION_PANEL_ID}
        aria-labelledby={getPillTabId(PROJECT_SECTION_PANEL_ID, activeView)}
        className={cn(
          'flex w-full flex-col px-1',
          activeView === 'workspaces' && 'min-h-[calc(100vh-16rem)]',
          (activeView === 'tasks' || activeView === 'pull-request') &&
            'h-[calc(100vh-16rem)] min-h-96',
          // Settings scrolls internally with a pinned footer, so its floor must
          // fit the smallest supported window (500px − 16rem chrome = 244px);
          // a larger floor would nest the section scroll inside the page scroll
          // and strand the footer while the header and tabs scroll away.
          activeView === 'settings' && 'h-[calc(100vh-16rem)] min-h-60'
        )}
      >
        {activeView === 'tasks' && <TaskList />}
        {activeView === 'pull-request' && <PullRequestView />}
        {activeView === 'workspaces' && <ProjectWorkspacesView projectId={projectId} />}
        {activeView === 'settings' && (
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <SettingsPanel />
          </div>
        )}
      </section>
    </div>
  );
});
