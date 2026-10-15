import type { SqliteConnection } from '#primitives/sqlite-store/api';

/** SQLite's `auto_vacuum` value for INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;

/** Free pages left behind before a rebuild hands them back to the filesystem (8 MB at 4 KB). */
export const RECLAIM_FREE_PAGE_THRESHOLD = 2_048;

/**
 * Switches the index to incremental auto-vacuum, once. Every rebuild writes a full new generation
 * and deletes the old one, and without this the freed pages never leave the file: a busy root
 * grew one install's index to 1.7 GB, two thirds of it free. Changing the mode on an existing
 * file takes one VACUUM, which this runs on open inside the file-search worker.
 */
export function enableIncrementalVacuum(connection: SqliteConnection): void {
  const current = connection.get<{ auto_vacuum: number }>('PRAGMA auto_vacuum');
  if (current?.auto_vacuum === AUTO_VACUUM_INCREMENTAL) return;
  connection.exec(`PRAGMA auto_vacuum = ${AUTO_VACUUM_INCREMENTAL}`);
  connection.exec('VACUUM');
}

/** Returns free pages to the filesystem once enough have piled up. */
export function reclaimFreePages(
  connection: SqliteConnection,
  threshold = RECLAIM_FREE_PAGE_THRESHOLD
): void {
  const free = connection.get<{ freelist_count: number }>('PRAGMA freelist_count');
  if ((free?.freelist_count ?? 0) < threshold) return;
  connection.exec('PRAGMA incremental_vacuum');
}
