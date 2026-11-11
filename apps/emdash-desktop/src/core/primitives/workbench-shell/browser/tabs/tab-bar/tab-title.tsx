import { observer } from 'mobx-react-lite';
import { cn } from '@core/primitives/styling/browser/cn';

export const TabTitle = observer(function TabTitle({
  isPreview,
  hasError,
  maxWidth = 'max-w-[200px]',
  className,
  children,
}: {
  /** Kept for callers; the tab around the title owns the active colour. */
  isActive: boolean;
  isPreview?: boolean;
  hasError?: boolean;
  maxWidth?: string;
  className?: string;
  children: React.ReactNode;
}) {
  // The tab owns the colour (active, inactive, unfocused pane); the title adds only preview and
  // error. The weight never changes with the state, so switching tabs does not shift the strip.
  return (
    <span
      className={cn(
        'truncate p-1 text-sm',
        maxWidth,
        isPreview && 'italic',
        hasError && 'text-foreground-destructive',
        className
      )}
    >
      {children}
    </span>
  );
});
