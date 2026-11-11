import { cn } from '@core/primitives/styling/browser/cn';

export function PrNumberBadge({ number, className }: { number: number; className?: string }) {
  return (
    <span className={cn('shrink-0 text-xs text-foreground-muted tabular-nums', className)}>
      #{number}
    </span>
  );
}
