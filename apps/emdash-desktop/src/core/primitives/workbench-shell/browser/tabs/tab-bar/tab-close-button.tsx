import { X } from 'lucide-react';

export function TabCloseButton({
  onClose,
  ariaLabel,
  statusIndicator,
}: {
  onClose: () => void;
  ariaLabel: string;
  statusIndicator?: React.ReactNode;
}) {
  return (
    <div className="relative flex size-5 shrink-0 items-center justify-center">
      {statusIndicator}
      {/* Shown on hover, or when reached by keyboard. */}
      <button
        className="absolute inset-0 flex items-center justify-center rounded-sm text-foreground-passive opacity-0 transition-opacity group-hover:opacity-100 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label={ariaLabel}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
