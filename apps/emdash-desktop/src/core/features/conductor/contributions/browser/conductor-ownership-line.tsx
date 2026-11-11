import { computed, type IComputedValue } from 'mobx';
import { observer } from 'mobx-react-lite';
import { getCanvasStore } from '@core/features/canvas/contributions/browser/app-stores';
import { cn } from '@core/primitives/styling/browser/cn';
import { ownershipCounts, ownershipLine } from '../../api/ownership-line';

/**
 * Maestro's own row at the top of the sidebar: its name, and under it how many tasks wait on the
 * developer and how many are still at work ("Two are yours · 3 at work"). Live: it observes only a
 * computed of the line's text, so it re-renders when the text changes, not on every agent change.
 */
export const ConductorOwnershipLine = observer(function ConductorOwnershipLine({
  className,
}: {
  className?: string;
}) {
  const line = ownershipText();
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <span className="truncate text-sm/5 font-medium text-foreground">Maestro</span>
      <span className="truncate text-xs text-foreground-muted" title={line}>
        {line}
      </span>
    </div>
  );
});

type CanvasStore = ReturnType<typeof getCanvasStore>;

/** One line per canvas store, recounted when its agent entries change. */
const lines = new WeakMap<CanvasStore, IComputedValue<string>>();

function ownershipText(): string {
  const canvas = getCanvasStore();
  let line = lines.get(canvas);
  if (!line) {
    line = computed(() => ownershipLine(ownershipCounts(canvas.agentEntries)));
    lines.set(canvas, line);
  }
  return line.get();
}
