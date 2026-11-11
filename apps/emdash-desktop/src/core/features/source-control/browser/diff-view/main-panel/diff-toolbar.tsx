import { ToggleGroup } from '@emdash/ui/react/primitives';
import { AlignJustify, Columns2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import type { DiffTabResource } from '../stores/diff-tab-resource';

interface DiffToolbarProps {
  tab: DiffTabResource;
}

export const DiffToolbar = observer(function DiffToolbar({ tab }: DiffToolbarProps) {
  const diffView = useTaskComposition().diffView;
  const diffStyle = diffView?.diffStyle;
  const canPreview = tab.renderer.kind === 'text' && tab.renderer.previewKind !== undefined;

  const diffSourceLabel = (() => {
    if (tab.diffGroup === 'staged') return 'Staged';
    if (tab.diffGroup === 'disk') return 'Working tree';
    if (tab.diffGroup === 'pr') return 'Pull request';
    if (tab.diffGroup === 'git') return 'Commit';
    return undefined;
  })();

  if (!diffView || !diffStyle) return null;

  const fileName = tab.path.split('/').pop() ?? tab.path;
  const directory = tab.path.slice(0, tab.path.length - fileName.length);

  // A toolbar strip on the content surface (no rule under it): which diff this
  // is on the left, as a path and its source in caption tone; the view
  // controls on the right as quiet segmented controls.
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-3 bg-(--em-surface) pr-2 pl-4">
      <div className="flex min-w-0 items-baseline gap-2" title={tab.path}>
        <span className="min-w-0 truncate text-xs text-foreground-muted">
          {directory && <span className="text-foreground-passive">{directory}</span>}
          {fileName}
        </span>
        {diffSourceLabel && (
          <span className="shrink-0 text-tiny text-foreground-passive">{diffSourceLabel}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canPreview && (
          <ToggleGroup.Root
            multiple={false}
            aria-label="Show"
            value={[tab.viewMode]}
            onValueChange={([value]) => {
              if (value === 'diff' || value === 'preview') tab.setViewMode(value);
            }}
          >
            <ToggleGroup.Item size="xs" value="diff">
              Diff
            </ToggleGroup.Item>
            <ToggleGroup.Item size="xs" value="preview">
              Preview
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
        {tab.viewMode === 'diff' && (
          <ToggleGroup.Root
            multiple={false}
            aria-label="Diff layout"
            value={[diffStyle]}
            onValueChange={([value]) => {
              if (value) {
                diffView.setDiffStyle(value as 'unified' | 'split');
              }
            }}
          >
            <ToggleGroup.Item size="xs" icon value="unified" aria-label="Unified diff">
              <AlignJustify className="size-3.5" />
            </ToggleGroup.Item>
            <ToggleGroup.Item size="xs" icon value="split" aria-label="Split diff">
              <Columns2 className="size-3.5" />
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        )}
      </div>
    </div>
  );
});
