import { PageLayout } from '@emdash/ui/react/patterns';
import type { SettingsPageProps } from '@core/primitives/settings/api/page-contribution';
import { WorkspacesListView } from '../components/workspaces-list-view';

export function LocalWorkspacesSettingsPage({ openDetail }: SettingsPageProps) {
  return (
    <div className="flex min-h-0 flex-col pb-16">
      <PageLayout.Header
        sticky
        title="Workspaces"
        description="Each project's folders on this computer: review their size and remove stale task worktrees."
      />
      <WorkspacesListView scope={{ kind: 'local' }} openDetail={openDetail} />
    </div>
  );
}
