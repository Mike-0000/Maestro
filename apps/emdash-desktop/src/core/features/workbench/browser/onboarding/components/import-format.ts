import type { LegacyImportSource } from '@core/primitives/legacy-port/api/legacy-port';

/** The earlier versions whose data can be brought over, in plain words. */
export function sourceLabel(source: LegacyImportSource): string {
  return source === 'v0' ? 'Version 0' : 'Version 1 beta';
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
