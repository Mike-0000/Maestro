import { Button } from '@emdash/ui/react/primitives';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The automation sheets' header (dialog anatomy, design brief 2.9): the title block on the left,
 * the close button top right, no rule under it. `title` is usually a `Sheet.Title`; the detail
 * sheet passes its editable name instead.
 */
export function SheetHeader({
  title,
  description,
  onClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {title}
        {description != null && <div className="text-sm text-foreground-muted">{description}</div>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon
        onClick={onClose}
        aria-label="Close"
        className="-mt-1 -mr-2 shrink-0"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
