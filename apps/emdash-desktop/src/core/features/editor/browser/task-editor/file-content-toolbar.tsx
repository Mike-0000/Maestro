import { Tabs } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import type { FileTabResource } from '@core/features/editor/api/browser/task-editor/stores/file-tab-resource';
import { useWorkspace } from '@core/features/workbench/api/browser/task-composition-context';
import { relativeToWorkspace } from '@core/features/workspaces/api/browser/workspace-path';
import { CompactedPathLabel } from './compacted-path-label';

interface FileContentToolbarProps {
  tab: FileTabResource;
  canToggle: boolean;
}

/**
 * Quiet strip over every file tab: the path as a caption on the left (shortened in the middle so
 * the file name always shows), Raw / Preview as underline tabs on the right. No rule under it;
 * the editor starts on the same paper.
 */
export const FileContentToolbar = observer(function FileContentToolbar({
  tab,
  canToggle,
}: FileContentToolbarProps) {
  const workspace = useWorkspace();
  const displayPath = tab.inWorkspace
    ? relativeToWorkspace(workspace.path, tab.path)
    : tab.displayPath;
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-4 px-3">
      <span className="min-w-0 flex-1 text-xs text-foreground-passive">
        <CompactedPathLabel path={displayPath} title={tab.displayPath} />
      </span>
      {canToggle && (
        <Tabs.Root
          value={tab.viewMode}
          onValueChange={(value) => {
            if (value === 'preview' || value === 'source') tab.setViewMode(value);
          }}
        >
          <Tabs.List variant="underline" aria-label="File view">
            <Tabs.Tab value="source" size="sm">
              Raw
            </Tabs.Tab>
            <Tabs.Tab value="preview" size="sm">
              Preview
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
      )}
    </div>
  );
});
