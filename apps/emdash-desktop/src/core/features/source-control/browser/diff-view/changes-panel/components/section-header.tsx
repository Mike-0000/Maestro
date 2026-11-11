import { Checkbox } from '@emdash/ui/react/primitives';
import { ChevronRight } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';
import { type SelectionState } from '../../stores/changes-view-store';

interface SectionHeaderProps {
  label: string;
  count: number;
  selectionState?: SelectionState;
  onToggleAll?: () => void;
  actions?: React.ReactNode;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function SectionHeader({
  label,
  count,
  selectionState,
  onToggleAll,
  actions,
  collapsed,
  onToggleCollapsed,
}: SectionHeaderProps) {
  const showCheckbox = selectionState !== undefined && onToggleAll !== undefined;
  const hasSelection = selectionState === 'all' || selectionState === 'partial';
  return (
    // Inert fixed-height row rendered as a direct child of the sections
    // Resizable.Group (the library ignores non-panel children for layout
    // math). Sections separate by space and their group label, not rules; the
    // resize handles between expanded bodies are ghost handles. When the panel is
    // too narrow for the label beside the actions, the actions wrap to a second
    // line, right-aligned, instead of truncating the label (as the footer does).
    <div className="group/section flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-2 pt-1 pr-4 pl-3">
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-2 pl-1 text-tiny text-foreground-passive transition-colors outline-none hover:text-foreground-muted focus-visible:text-foreground-muted focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            !collapsed && 'rotate-90'
          )}
        />
        <span className="truncate">{label}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      <div className="ml-auto flex min-h-7 shrink-0 items-center gap-1.5">
        {actions}
        {showCheckbox && (
          <Checkbox
            checked={selectionState === 'all'}
            indeterminate={selectionState === 'partial'}
            onCheckedChange={onToggleAll}
            aria-label={`Select all ${label.toLowerCase()}`}
            className={cn(
              'transition-opacity',
              // At rest the box only shows while something is selected; it
              // comes up with the row on hover or keyboard focus.
              !hasSelection && 'opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100'
            )}
          />
        )}
      </div>
    </div>
  );
}
