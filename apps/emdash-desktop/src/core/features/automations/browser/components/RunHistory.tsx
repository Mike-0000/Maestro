import { EmptyState } from '@emdash/ui/react/components';
import { Button, ToggleGroup } from '@emdash/ui/react/primitives';
import { useState } from 'react';
import type { Automation } from '@core/primitives/automations/api';
import type { RunHistoryFilter } from '../automation-run-store';
import {
  useAutomationRunCounts,
  useAutomationRunHistory,
  useAutomationTargetAvailability,
} from '../use-automations';
import { AutomationRunRow } from './AutomationRunRow';

const PAGE_SIZE = 25;

const FILTERS: { value: RunHistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface RunHistoryProps {
  automation: Automation;
}

/**
 * The automation's runs: a quiet status filter with counts (the project task list's
 * Active / Archived control), then the runs as two-line rows on the sheet, newest first.
 */
export function RunHistory({ automation }: RunHistoryProps) {
  const [filter, setFilter] = useState<RunHistoryFilter>('all');
  const availability = useAutomationTargetAvailability(automation.projectId);
  const runtimeAvailable = availability.data?.available === true;
  const runs = useAutomationRunHistory(
    automation.projectId!,
    automation.id,
    filter,
    PAGE_SIZE,
    runtimeAvailable
  );
  const counts = useAutomationRunCounts(
    automation.projectId!,
    automation.id,
    runtimeAvailable
  ).data;

  return (
    <section className="flex flex-col gap-3" aria-label="Runs">
      <ToggleGroup.Root
        multiple={false}
        value={[filter]}
        aria-label="Show runs"
        className="self-start"
        onValueChange={([value]) => {
          if (value) setFilter(value as RunHistoryFilter);
        }}
      >
        {FILTERS.map(({ value, label }) => (
          <ToggleGroup.Item key={value} value={value} aria-label={`${label} (${counts[value]})`}>
            {label}
            <span className="text-foreground-passive tabular-nums">{counts[value]}</span>
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      <div className="flex min-h-40 flex-col gap-0.5">
        {!runtimeAvailable ? (
          <EmptyState
            bare
            label="Runs aren't available"
            description="Connect to the remote automation runtime to load its runs."
          />
        ) : runs.isPending ? (
          <EmptyState bare tone="loading" label="Loading runs…" />
        ) : runs.data.length > 0 ? (
          <>
            {runs.data.map((run) => (
              <AutomationRunRow
                key={run.id}
                runId={run.id}
                automationId={automation.id}
                projectId={automation.projectId ?? null}
                run={run}
              />
            ))}
            {runs.hasMore && (
              <div className="flex justify-center pt-2">
                <Button
                  variant="text"
                  size="sm"
                  disabled={runs.isLoadingMore}
                  onClick={() => void runs.loadMore()}
                >
                  {runs.isLoadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            bare
            label={filter === 'all' ? 'No runs yet' : 'No runs here'}
            description={
              filter === 'all'
                ? 'Each run shows up here, with the task it started.'
                : 'No runs have this status.'
            }
          />
        )}
      </div>
    </section>
  );
}
