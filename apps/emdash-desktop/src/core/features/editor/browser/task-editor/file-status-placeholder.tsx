import { EmptyState } from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { openWithOS } from '@core/features/workbench/api/browser/open-with-os';

/**
 * Placeholder for a file tab whose OpenFileStore entry is not ready: the
 * bounded loading state, the retryable seam errors, and the orphaned state
 * (which auto-recovers when the store transitions back to ready).
 *
 * One kit EmptyState on the editor's paper: what happened in a few words, the
 * file name under it, and at most one text action.
 */
export const FileStatusPlaceholder = observer(function FileStatusPlaceholder({
  resource,
}: {
  resource: FileTabResource;
}) {
  const status = resource.contentStatus;
  const fileName = resource.path.split('/').pop() ?? resource.path;

  if (status.kind === 'ready') return null;

  if (status.kind === 'loading') {
    // The store bounds the loading state itself, so the line shows straight away.
    return <EmptyState bare tone="loading" delayMs={0} label="Loading file…" />;
  }

  if (status.kind === 'orphaned') {
    return (
      <EmptyState
        bare
        label="File was deleted on disk"
        description={`${fileName} comes back here by itself if the file is restored.`}
      />
    );
  }

  const openInDefaultApp = () => {
    if (resource.ref) void openWithOS(resource.ref);
  };
  const retry = (
    <Button variant="text" onClick={() => resource.retryLoad()}>
      Try again
    </Button>
  );
  const openAction =
    resource.ref?.host.type === 'local' ? (
      <Button variant="text" onClick={openInDefaultApp}>
        Open in default app
      </Button>
    ) : undefined;

  switch (status.code) {
    case 'not-found':
      return (
        <EmptyState
          bare
          tone="error"
          label="File not found"
          description={fileName}
          action={retry}
        />
      );
    case 'no-permissions':
      return (
        <EmptyState
          bare
          tone="error"
          label="Permission denied"
          description={`${fileName} cannot be read with your permissions.`}
          action={retry}
        />
      );
    case 'too-large':
      return (
        <EmptyState
          bare
          label="File too large to display in the editor"
          description={fileName}
          action={openAction}
        />
      );
    case 'binary':
      return (
        <EmptyState
          bare
          label="Binary file, no preview"
          description={fileName}
          action={openAction}
        />
      );
    case 'unavailable':
      return (
        <EmptyState
          bare
          tone="error"
          label="Could not load file"
          description={fileName}
          action={retry}
        />
      );
  }
});
