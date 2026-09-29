import type { WorkspaceRecords } from '@emdash/core/runtimes/workspace-registry/api';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  compareWorkspaceRows,
  createWorkspaceRegistry,
  isAnnotatedWorkspace,
  liveWorkspaces,
  observationMatchesRow,
  workspaceObservationFromRecord,
  workspaceRegistryTable as workspaces,
  type WorkspaceHostIdentity,
  type WorkspaceRegistry,
} from '@core/features/workspaces/api/node/registry';
import { workspacePathIdentityKey } from '@core/features/workspaces/api/workspace-path-identity';
import type { AppDb, DrizzleTx } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { type WorkspaceRow } from '@core/services/app-db/node/schema';
import { loadWorkspaceAnnotations } from './workspace-annotations';

export interface ApplyWorkspaceRegistrySnapshotInput {
  db: AppDb;
  host: WorkspaceHostIdentity;
  records: WorkspaceRecords;
  /** Epoch-ms observation stamp; defaults to now. */
  observedAt?: number;
}

export interface ApplyWorkspaceRegistrySnapshotResult {
  adopted: number;
  refreshed: number;
  markedMissing: number;
  untracked: number;
  /** Tombstoned rows whose host record this delivery confirmed gone (ADR 0006). */
  purgedTombstones: number;
}

export class WorkspaceIdentityConflictError extends Error {
  readonly name = 'WorkspaceIdentityConflictError';

  constructor(
    readonly host: WorkspaceHostIdentity,
    readonly path: string,
    readonly incomingId: string,
    readonly conflictingId: string
  ) {
    super(
      `Workspace identity conflict at '${path}': Host delivered '${incomingId}', desktop has '${conflictingId}'`
    );
  }

  fingerprint(): string {
    return [
      this.host.location,
      this.host.sshConnectionId ?? 'local',
      workspacePathIdentityKey(this.path),
      this.incomingId,
      this.conflictingId,
    ].join('\u0000');
  }
}

/**
 * Converges the desktop workspace mirror toward one host's registry (ADR 0005): every
 * `records` delivery applies as a single idempotent transaction through the registry
 * sole-writer verbs — refresh matches by id, adopt unknowns, sweep unmatched rows
 * through the missing rules. Observations (the git block, create outcome, runtime
 * overlay included) overwrite wholesale; annotations are never touched. Callers must
 * only invoke this after a successful read: an unreachable host sweeps nothing.
 */
export async function applyWorkspaceRegistrySnapshot(
  input: ApplyWorkspaceRegistrySnapshotInput
): Promise<ApplyWorkspaceRegistrySnapshotResult> {
  const now = new Date().toISOString();
  const registry = createWorkspaceRegistry(input.db, { now: () => now });
  const { changed, ...result } = input.db.transaction((tx) =>
    applyWorkspaceRegistrySnapshotTx(tx, input, registry, now)
  );
  // Hosts republish their full map whenever any record is re-observed; only wake
  // workspace readers when this delivery actually changed a row.
  if (changed) appDbPokes.workspaces.poke({});
  return result;
}

/** How stale a row's `observedAt` may get before an unchanged delivery re-stamps it. */
const OBSERVED_AT_RESOLUTION_MS = 30_000;

function applyWorkspaceRegistrySnapshotTx(
  tx: DrizzleTx,
  input: ApplyWorkspaceRegistrySnapshotInput,
  registry: WorkspaceRegistry,
  now: string
): ApplyWorkspaceRegistrySnapshotResult & { changed: boolean } {
  const observedAt = input.observedAt ?? Date.now();
  const hostRows = loadLiveHostRows(tx, input.host);
  const annotations = loadWorkspaceAnnotations(
    tx,
    hostRows.map((row) => row.id)
  );
  // Path identity keys are pure but not cheap (full path parsing); each path is keyed by
  // several checks below, on every delivery.
  const keyOf = memoizePathKeys();
  assertNoIdentityConflicts(input.host, hostRows, input.records, keyOf);
  releaseMovedPaths(tx, hostRows, input.records, keyOf);
  const counts: ApplyWorkspaceRegistrySnapshotResult = {
    adopted: 0,
    refreshed: 0,
    markedMissing: 0,
    untracked: 0,
    purgedTombstones: 0,
  };

  const tombstoned = loadTombstonedIds(
    tx,
    Object.values(input.records).map((record) => record.id)
  );
  const rowById = new Map(hostRows.map((row) => [row.id, row]));
  const pathOwners = oldestRowByPathKey(hostRows, keyOf);
  const stale: string[] = [];
  let changed = false;
  const seen = new Set<string>();
  for (const record of Object.values(input.records)) {
    seen.add(record.id);
    // Desktop untracking is durable: a delivery never resurrects a tombstoned row.
    if (tombstoned.has(record.id)) continue;
    const observation = workspaceObservationFromRecord(record, input.host, observedAt);
    // Most deliveries re-observe rows that have not changed (the host republishes its
    // whole map on every scan). When the row still owns its path identity (the same check
    // `refresh` makes), such a row is only re-stamped, batched below, once its stamp is
    // older than OBSERVED_AT_RESOLUTION_MS.
    const known = rowById.get(record.id);
    if (
      known !== undefined &&
      observationMatchesRow(known, observation) &&
      pathOwners.get(keyOf(record.path))?.id === known.id
    ) {
      if (known.observedAt === null || observedAt - known.observedAt >= OBSERVED_AT_RESOLUTION_MS) {
        stale.push(known.id);
      }
      counts.refreshed += 1;
      continue;
    }
    changed = true;
    // Matching is a primary-key lookup on the preserved workspace UUID — the host
    // already resolved moves and adoptions; no path or admin-name matching here.
    const existing = known ?? registry.getLive(record.id, tx);
    if (existing === undefined) {
      registry.adopt(
        {
          id: record.id,
          type: input.host.location === 'remote' ? 'project-ssh' : 'local',
          ...observation,
          createdAt: new Date(record.createdAt).toISOString(),
        },
        tx
      );
      counts.adopted += 1;
      continue;
    }
    registry.refresh(record.id, observation, tx);
    counts.refreshed += 1;
  }
  // Readers show sync time at minute granularity; waking them for a re-stamp every few
  // seconds would only repeat the same rows.
  if (registry.stampObserved(stale, observedAt, tx) > 0) changed = true;

  for (const row of hostRows) {
    if (seen.has(row.id)) continue;
    // Purge-on-mirror-confirmed-gone (ADR 0006): the delivery is the host's full
    // snapshot, so a live tombstoned row absent from it has converged — the pending
    // deletion completed (or the record never existed). The untrack is the purge;
    // annotation never keeps a row the user already deleted visible as missing.
    if (row.deletionTombstone !== null) {
      registry.untrack([row.id], now, undefined, tx);
      counts.purgedTombstones += 1;
      changed = true;
      continue;
    }
    const annotated = isAnnotatedWorkspace({
      config: row.config,
      hasTaskLink: annotations.taskWorkspaceIds.has(row.id),
      isProjectRepository: annotations.projectRepositoryWorkspaceIds.has(row.id),
    });
    if (annotated) {
      // Annotated rows stay visible as missing until the user acts.
      registry.refresh(row.id, { observedStatus: 'missing', observedAt }, tx);
      counts.markedMissing += 1;
      changed ||= row.observedStatus !== 'missing';
    } else {
      // Pure mirror entries follow the mirror.
      registry.untrack([row.id], now, undefined, tx);
      counts.untracked += 1;
      changed = true;
    }
  }

  return { ...counts, changed };
}

/** The row `findLiveByPath` would return for each path identity on this host. */
function oldestRowByPathKey(
  rows: readonly WorkspaceRow[],
  keyOf: PathKeyOf
): Map<string, WorkspaceRow> {
  const owners = new Map<string, WorkspaceRow>();
  for (const row of rows) {
    if (row.path === null) continue;
    const key = keyOf(row.path);
    const owner = owners.get(key);
    if (owner === undefined || compareWorkspaceRows(row, owner) < 0) owners.set(key, row);
  }
  return owners;
}

/**
 * A full snapshot may contain a valid path swap, or move a known record away before
 * an unknown record takes its old path. Release all moved paths as one first phase so
 * SQLite's live-path unique index cannot make the outcome depend on record order.
 * The surrounding transaction restores every path if a later write fails.
 */
function releaseMovedPaths(
  tx: DrizzleTx,
  rows: readonly WorkspaceRow[],
  records: WorkspaceRecords,
  keyOf: PathKeyOf
): void {
  const incomingPathById = new Map(
    Object.values(records).map((record) => [record.id, record.path])
  );
  const movedIds = rows.flatMap((row) => {
    const incomingPath = incomingPathById.get(row.id);
    return incomingPath !== undefined &&
      (row.path === null || keyOf(incomingPath) !== keyOf(row.path))
      ? [row.id]
      : [];
  });
  if (movedIds.length === 0) return;
  tx.update(workspaces).set({ path: null }).where(inArray(workspaces.id, movedIds)).run();
}

function loadLiveHostRows(tx: DrizzleTx, host: WorkspaceHostIdentity): WorkspaceRow[] {
  const hostIdentity =
    host.sshConnectionId === null
      ? isNull(workspaces.sshConnectionId)
      : eq(workspaces.sshConnectionId, host.sshConnectionId);
  return tx
    .select()
    .from(workspaces)
    .where(and(liveWorkspaces(), eq(workspaces.location, host.location), hostIdentity))
    .all();
}

function loadTombstonedIds(tx: DrizzleTx, recordIds: string[]): Set<string> {
  if (recordIds.length === 0) return new Set();
  const rows = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.id, recordIds), isNotNull(workspaces.untrackedAt)))
    .all();
  return new Set(rows.map((row) => row.id));
}

function assertNoIdentityConflicts(
  host: WorkspaceHostIdentity,
  rows: readonly WorkspaceRow[],
  records: WorkspaceRecords,
  keyOf: PathKeyOf
): void {
  const ownerByPath = new Map<string, string>();
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.path !== null) ownerByPath.set(keyOf(row.path), row.id);
  }
  // A known id may legitimately move. Release its old observed path in the
  // preflight model before checking the full incoming assignment.
  for (const record of Object.values(records)) {
    const previous = rowById.get(record.id);
    if (previous?.path) {
      const previousKey = keyOf(previous.path);
      if (ownerByPath.get(previousKey) === record.id) ownerByPath.delete(previousKey);
    }
  }
  for (const record of Object.values(records)) {
    const pathKey = keyOf(record.path);
    const conflictingId = ownerByPath.get(pathKey);
    if (conflictingId !== undefined && conflictingId !== record.id) {
      throw new WorkspaceIdentityConflictError(host, record.path, record.id, conflictingId);
    }
    ownerByPath.set(pathKey, record.id);
  }
}

type PathKeyOf = (path: string) => string;

function memoizePathKeys(): PathKeyOf {
  const keys = new Map<string, string>();
  return (path) => {
    let key = keys.get(path);
    if (key === undefined) {
      key = workspacePathIdentityKey(path);
      keys.set(path, key);
    }
    return key;
  };
}
