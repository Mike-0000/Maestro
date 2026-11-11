import type { ResourceUsageSample } from '@emdash/core/runtimes/resource-usage/api';
import { SettingsSection } from '@emdash/ui/react/patterns';

/**
 * CPU, memory and disk as three figures in one settings card: a muted label, the figure, and a
 * caption with the amounts. No boxed tiles; the figures and their alignment do the work.
 */
export function ResourceUtilizationRow({ metrics }: { metrics: ResourceUsageSample | null }) {
  return (
    <SettingsSection title="Resources">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
        <ResourceFigure
          label="CPU"
          value={metrics ? formatPercent(metrics.cpu.usedPercent) : '—'}
          description={metrics ? 'In use now' : 'Not measured yet'}
        />
        <ResourceFigure
          label="Memory"
          value={metrics ? formatPercent(metrics.memory.usedPercent) : '—'}
          description={
            metrics
              ? `${formatBytes(metrics.memory.usedBytes)} of ${formatBytes(metrics.memory.totalBytes)}`
              : 'Not measured yet'
          }
        />
        <ResourceFigure
          label="Disk"
          value={metrics ? formatPercent(metrics.disk.usedPercent) : '—'}
          description={
            metrics
              ? `${formatBytes(metrics.disk.usedBytes)} of ${formatBytes(metrics.disk.totalBytes)}`
              : 'Not measured yet'
          }
        />
      </dl>
    </SettingsSection>
  );
}

function ResourceFigure({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="mt-1 text-xl text-foreground tabular-nums">{value}</dd>
      <dd className="mt-0.5 truncate text-tiny text-foreground-passive tabular-nums">
        {description}
      </dd>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(maximumFractionDigits)} ${units[unitIndex]}`;
}
