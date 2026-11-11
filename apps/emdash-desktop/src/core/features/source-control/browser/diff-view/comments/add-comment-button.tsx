import { Plus } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';

interface AddCommentButtonProps {
  pinned: boolean;
  onClick: () => void;
}

/** The "+" in the diff gutter: a mini icon button, filled while its comment input is open. */
export function AddCommentButton({ pinned, onClick }: AddCommentButtonProps) {
  return (
    <button
      type="button"
      aria-label="Add a comment on this line"
      className={cn(
        'flex size-5 cursor-pointer items-center justify-center rounded-sm transition-colors',
        pinned
          ? 'bg-surface-selected text-foreground'
          : 'bg-transparent text-foreground-passive hover:bg-surface-hover hover:text-foreground'
      )}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Plus className="size-3.5" />
    </button>
  );
}
