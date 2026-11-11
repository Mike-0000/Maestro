/** A thin quiet bar and the percentage in the caption role. */
export function ImportProgress({ progress }: { progress: number }) {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="flex w-full max-w-xs shrink-0 flex-col items-center gap-2">
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1 w-full overflow-hidden rounded-full bg-surface-emphasis"
      >
        <div
          className="h-full rounded-full bg-foreground-muted transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="text-tiny text-foreground-passive tabular-nums">Importing… {value}%</p>
    </div>
  );
}
