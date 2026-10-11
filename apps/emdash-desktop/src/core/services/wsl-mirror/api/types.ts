/**
 * A live mirror keeps a project folder on a Windows drive and its copy inside a WSL2 distro the
 * same, both ways, while the app runs. These are the shapes the app shows of it.
 */

export type MirrorPhase = 'starting' | 'seeding' | 'syncing' | 'synced' | 'paused' | 'error';

export type MirrorConflict = {
  /** A file path, or a branch name. */
  readonly path: string;
  /**
   * - `file`: changed on both sides; one version stands and the other was kept aside.
   * - `branch`: has different commits on each side.
   * - `type`: a file on one side and a folder on the other.
   * - `stuck`: cannot be carried over (a name the other system cannot hold, a file held open).
   */
  readonly kind: 'file' | 'branch' | 'type' | 'stuck';
  /**
   * Whose version is in place now. For a branch and a type conflict both are, each on its own
   * side; for a stuck file, the side that has it.
   */
  readonly kept: 'windows' | 'wsl' | 'both';
  readonly at: number;
};

export type MirrorStatus = {
  readonly phase: MirrorPhase;
  /** Files in the mirror. */
  readonly files: number;
  /** Changes a round could not finish yet. */
  readonly pending: number;
  readonly lastSyncedAt: number | null;
  readonly conflicts: readonly MirrorConflict[];
  /** Symbolic links, which are not mirrored. */
  readonly links: number;
  /** Why git state is not being mirrored, when it is not. */
  readonly gitNote: string | null;
  readonly error: string | null;
};

export type WslMirrorLink = {
  readonly id: string;
  readonly name: string;
  /** The project folder on a Windows drive. */
  readonly windowsPath: string;
  readonly distro: string;
  /** The copy's absolute path inside the distro. */
  readonly linuxPath: string;
  /** The machine the distro is in the app, when it is one. */
  readonly machineId: string | null;
  readonly paused: boolean;
  /** The first run, which makes the copy match the Windows folder, is done. */
  readonly seeded: boolean;
  readonly createdAt: number;
};

export type WslMirrorInfo = WslMirrorLink & { readonly status: MirrorStatus };

/** One line saying how a mirror is doing, for a menu or a tooltip. */
export function describeMirror(status: MirrorStatus): string {
  switch (status.phase) {
    case 'starting':
      return status.error ? `Reconnecting: ${status.error}` : 'Starting';
    case 'seeding':
      return 'Copying the project into WSL';
    case 'syncing':
      return status.pending > 0 ? `Syncing (${status.pending} waiting)` : 'Syncing';
    case 'synced':
      return status.conflicts.length > 0
        ? `In sync, ${status.conflicts.length} conflict${status.conflicts.length === 1 ? '' : 's'} kept`
        : 'In sync';
    case 'paused':
      return 'Paused';
    case 'error':
      return `Stopped: ${status.error ?? 'unknown error'}`;
  }
}
