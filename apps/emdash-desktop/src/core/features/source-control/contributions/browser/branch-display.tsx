import { GitBranch } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';

interface BranchDisplayProps {
  label: string;
  branchName: string;
  className?: string;
}

/**
 * A branch that is fixed for this form: the field label above, then the branch
 * in a read-only field (a hairline box with no fill, muted text) so it lines
 * up with the editable selects beside it without inviting a click.
 */
export function BranchDisplay({ label, branchName, className }: BranchDisplayProps) {
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs text-foreground-muted">{label}</span>
      <span
        title={branchName}
        className="flex h-8 min-w-0 cursor-default items-center gap-2 rounded-md border border-border-subtle px-2.5 text-sm text-foreground-muted"
      >
        <GitBranch aria-hidden className="size-3.5 shrink-0 text-foreground-passive" />
        <span className="min-w-0 truncate">{branchName}</span>
      </span>
    </div>
  );
}
