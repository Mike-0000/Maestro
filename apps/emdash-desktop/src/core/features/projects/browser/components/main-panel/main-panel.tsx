import { EmptyState } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { isUnregisteredProject } from '@core/features/projects/api/browser/stores/project';
import type { ProjectContextError } from '@core/features/projects/api/browser/stores/project-context';
import {
  getProjectManagerStore,
  getProjectStore,
  projectDisplayName,
  projectViewKind,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { ProjectAvailabilityBoundary } from '@core/features/projects/contributions/browser/project-availability-boundary';
import { useConfirmDeleteProject } from '@core/features/projects/contributions/browser/use-confirm-delete-project';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { BorderlessTitlebar } from '@core/features/workbench/contributions/browser/BorderlessTitlebar';
import { useCurrentViewParams } from '@core/primitives/navigation/browser/navigation-hooks';
import { ProjectErrorDetails } from '../project-error-details';
import { ActiveProject } from './active-project';
import { PendingProjectStatus } from './pending-project';
import { ProjectHeader } from './project-header';

export function ProjectMainPanel() {
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <BorderlessTitlebar />
      <ProjectMainPanelContent />
    </div>
  );
}

const ProjectMainPanelContent = observer(function ProjectMainPanelContent() {
  const {
    params: { projectId },
  } = useCurrentViewParams(projectViewDef);
  const store = getProjectStore(projectId);
  const kind = projectViewKind(store);
  const displayName = projectDisplayName(store) ?? 'this project';
  const confirmDeleteProject = useConfirmDeleteProject();

  if (kind === 'creating' && store && isUnregisteredProject(store)) {
    return <PendingProjectStatus project={store} />;
  }

  if (kind === 'hydrating') {
    return (
      <ProjectPageShell projectId={projectId}>
        <ProjectContextHydratingPanel />
      </ProjectPageShell>
    );
  }

  if (kind === 'context_error' && store?.context?.kind === 'failed') {
    return (
      <ProjectPageShell projectId={projectId}>
        <ProjectContextErrorPanel
          error={store.context.error}
          onRemove={() => {
            void confirmDeleteProject({ projectId, projectLabel: displayName });
          }}
          onRetry={() => {
            void getProjectManagerStore().hydrateProjectContext(projectId);
          }}
        />
      </ProjectPageShell>
    );
  }

  if (kind !== 'ready') {
    return <div className="flex flex-1 items-center justify-center text-foreground-muted" />;
  }

  return (
    <ProjectPageShell projectId={projectId}>
      <ProjectAvailabilityBoundary projectId={projectId} layout="inline">
        <ActiveProject />
      </ProjectAvailabilityBoundary>
    </ProjectPageShell>
  );
});

export function ProjectPageShell({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  return (
    <div
      data-project-page-scroll
      className="flex h-full min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto"
    >
      <div className="flex min-h-full w-full px-8 py-10">
        <div
          data-project-page-content
          className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-8"
        >
          <ProjectHeader projectId={projectId} />
          {children}
        </div>
      </div>
    </div>
  );
}

function ProjectContextHydratingPanel() {
  return (
    <div className="flex min-h-64 w-full flex-1 flex-col">
      <EmptyState tone="loading" label="Loading project…" />
    </div>
  );
}

export function ProjectContextErrorPanel({
  error,
  onRemove,
  onRetry,
}: {
  error: ProjectContextError;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const detail =
    error.type === 'invalid-project-record'
      ? 'The saved Project record is invalid.'
      : error.stage === 'memento'
        ? 'Saved Project view state could not be loaded.'
        : 'Project stores could not be initialized.';
  // The error-tone empty state: the error dot and a plain title, one sentence, then the moves as
  // text actions. The raw message stays behind "Error details" (it is redacted there).
  return (
    <div className="flex min-h-64 w-full flex-1 flex-col">
      <EmptyState
        tone="error"
        label="Could not load Project"
        description={detail}
        action={
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <Button type="button" variant="text" onClick={onRetry}>
              Retry
            </Button>
            <Button type="button" variant="text" onClick={onRemove}>
              Remove Project
            </Button>
            <ProjectErrorDetails message={error.message} />
          </div>
        }
      />
    </div>
  );
}
