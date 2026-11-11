import { type ReactNode } from 'react';

interface ActionCardProps {
  selectedCount: number;
  selectionActions: ReactNode;
  generalActions: ReactNode;
}

/**
 * The quiet line over a changes list: what the actions apply to on the left
 * (a caption), the actions themselves on the right as text actions. No card:
 * the section's one solid move is the commit button below the list.
 */
export function ActionCard({ selectedCount, selectionActions, generalActions }: ActionCardProps) {
  const hasSelection = selectedCount > 0;
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-3 px-4">
      <span className="min-w-0 truncate text-tiny text-foreground-passive tabular-nums">
        {hasSelection
          ? `${selectedCount} file${selectedCount !== 1 ? 's' : ''} selected`
          : 'All files'}
      </span>
      <div className="flex shrink-0 items-center gap-x-4">
        {hasSelection ? selectionActions : generalActions}
      </div>
    </div>
  );
}
