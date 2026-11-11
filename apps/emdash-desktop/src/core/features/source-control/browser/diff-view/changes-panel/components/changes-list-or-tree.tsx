import { type ChangesListViewMode } from '@core/primitives/app-settings/api';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  VirtualizedChangesList,
  type VirtualizedChangesListProps,
} from './virtualized-changes-list';
import { VirtualizedChangesTree } from './virtualized-changes-tree';

interface ChangesListOrTreeProps extends VirtualizedChangesListProps {
  viewMode: ChangesListViewMode;
}

/**
 * The kit's scroll fade on the list's own scroller: the top edge fades once scrolled, and the
 * bottom edge fades while more rows sit below, so a row cut by the edge above the commit box
 * dissolves instead of ending in a hard line (both clear when there is nothing to scroll).
 */
const CHANGES_LIST_FADE = 'scroll-fade__viewport sf-bottom';

export function ChangesListOrTree({ viewMode, className, ...props }: ChangesListOrTreeProps) {
  const listClassName = cn(CHANGES_LIST_FADE, className);
  if (viewMode === 'tree') return <VirtualizedChangesTree {...props} className={listClassName} />;
  return <VirtualizedChangesList {...props} className={listClassName} />;
}
