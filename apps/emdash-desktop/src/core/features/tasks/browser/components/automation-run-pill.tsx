import { FactGrid } from '@emdash/ui/react/patterns';
import { Button, Popover, RelativeTime } from '@emdash/ui/react/primitives';
import { Clock } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { cn } from '@core/primitives/styling/browser/cn';
import { registeredTaskData } from '@core/primitives/task-state/browser/task-state';

type AutomationRunPillProps = {
  taskStore: TaskStore;
  isConverted: boolean;
};

export const AutomationRunPill = observer(function AutomationRunPill({
  taskStore,
  isConverted,
}: AutomationRunPillProps) {
  const [open, setOpen] = useState(false);
  const [isConverting, setIsConverting] = useState(false);

  const runMeta = registeredTaskData(taskStore)?.automationRunMeta;
  const timestamp = runMeta?.finishedAt ?? runMeta?.startedAt ?? runMeta?.scheduledAt ?? null;
  const automationName = runMeta?.automationName ?? 'Automation run';

  async function handleConvert() {
    setIsConverting(true);
    try {
      await taskStore.convertAutomationTask();
      setOpen(false);
    } finally {
      setIsConverting(false);
    }
  }

  // A quiet chip in the title bar; the popover is a small fact list and, for a run that is
  // still an automation's, one text action to make it a regular task (design brief 2.7).
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground-muted transition-colors outline-none',
          'hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          'data-popup-open:bg-surface-hover data-popup-open:text-foreground'
        )}
      >
        <Clock className="size-3.5 shrink-0 text-foreground-passive" />
        <span className="max-w-28 truncate">{automationName}</span>
        {timestamp != null && (
          <RelativeTime
            value={timestamp}
            compact
            className="text-tiny text-foreground-passive tabular-nums"
          />
        )}
      </Popover.Trigger>
      <Popover.Content align="start" className="w-72">
        <FactGrid labelWidth="5rem">
          <FactGrid.Row label="Automation">{automationName}</FactGrid.Row>
          {timestamp != null && (
            <FactGrid.Row label="Ran">
              {new Date(timestamp).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </FactGrid.Row>
          )}
        </FactGrid>
        {!isConverted && (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-xs text-pretty text-foreground-muted">
              Convert to a regular task to manage it independently.
            </p>
            <Button
              variant="text"
              size="sm"
              disabled={isConverting}
              onClick={() => void handleConvert()}
            >
              {isConverting ? 'Converting…' : 'Convert to task'}
            </Button>
          </div>
        )}
      </Popover.Content>
    </Popover.Root>
  );
});
