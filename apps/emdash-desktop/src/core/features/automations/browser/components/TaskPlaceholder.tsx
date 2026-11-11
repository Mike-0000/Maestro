/**
 * A run's first line before (or without) a task: the generated name when there is one, else
 * "Creating task…" while the run is still starting, or what kind of run it was once it ended
 * without a task (a failed or skipped run).
 */
export function TaskPlaceholder({
  name,
  pending = true,
  fallback = 'Run',
}: {
  name: string | null;
  /** True while the run can still produce a task. */
  pending?: boolean;
  /** What to call a finished run that never got a task ("Scheduled run"). */
  fallback?: string;
}) {
  return (
    <div className="flex min-w-0 items-center">
      <span
        className={
          name
            ? 'min-w-0 truncate text-sm text-foreground'
            : 'min-w-0 truncate text-sm text-foreground-muted'
        }
      >
        {name ?? (pending ? 'Creating task…' : fallback)}
      </span>
    </div>
  );
}
