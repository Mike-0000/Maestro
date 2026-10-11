import type { MirrorConflict, MirrorPhase, MirrorStatus } from '../api/types';
import type { MirrorAgent } from './mirror-agents';
import {
  applyRescan,
  planMirror,
  resolveCompare,
  type Base,
  type BaseEntry,
  type CopyOp,
  type DeleteOp,
  type DirOp,
  type FileStat,
  type PlanMode,
  type Side,
  type Snapshot,
} from './mirror-plan';
import {
  agreedRefs,
  applyRefUpdates,
  headValue,
  planHead,
  planRefs,
  settleRef,
  updateRefInput,
  type Ancestry,
  type RefMap,
  type RefUpdate,
} from './mirror-refs';

/**
 * One running mirror: two agents, one on each side, and the loop that keeps their trees and
 * their git state the same. Side `a` is the Windows folder and side `b` its copy in the distro;
 * `b` is the one that can see both folders, so file contents are carried by `b`.
 *
 * A round reads what changed, plans (mirror-plan.ts), checks the plan against the disk, and
 * carries it out. Whatever a round cannot finish, because a file changed again or is held
 * open, is simply planned again in the next one. Nothing is removed unless the other side
 * really lacks the file, and files a round replaces or removes on a conflict are kept aside.
 */

export type MirrorState = {
  readonly version: 1;
  /** path, then size and time on `a`, then on `b`. */
  readonly files: Array<[string, number, number, number, number]>;
  readonly dirs: string[];
  readonly refs: RefMap | null;
  /** False while a new mirror's git state has not been brought in line with Windows yet. */
  readonly gitSeeded?: boolean;
  /** Absent when the two sides' HEADs never agreed. */
  readonly head?: string | null;
};

export type MirrorAgents = {
  readonly a: { agent: MirrorAgent; init: Record<string, unknown> };
  readonly b: { agent: MirrorAgent; init: Record<string, unknown> };
};

export type MirrorSessionOptions = {
  readonly createAgents: () => Promise<MirrorAgents>;
  readonly loadState: () => Promise<MirrorState | null>;
  readonly saveState: (state: MirrorState) => Promise<void>;
  /** The mirror is new: make `b` match `a` before treating them as equals. */
  readonly seed: boolean;
  /** The first run finished; the mirror must not be seeded again. */
  readonly onSeeded?: () => void | Promise<void>;
  readonly onStatus?: (status: MirrorStatus) => void;
  readonly log?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
  readonly timing?: Partial<MirrorTiming>;
};

export type MirrorTiming = {
  /** How long changes are collected before a round starts. */
  debounceMs: number;
  /** How often both trees are read in full, to catch anything a watcher missed. */
  fullScanMs: number;
  /** How often git state is compared even when nothing announced a change. */
  gitCheckMs: number;
  /** How often both trees are read when a watcher could not be set up. */
  degradedScanMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  restartMinMs: number;
  restartMaxMs: number;
  saveMs: number;
};

const DEFAULT_TIMING: MirrorTiming = {
  debounceMs: 150,
  fullScanMs: 5 * 60_000,
  gitCheckMs: 60_000,
  degradedScanMs: 3_000,
  retryMinMs: 500,
  retryMaxMs: 30_000,
  restartMinMs: 5_000,
  restartMaxMs: 60_000,
  saveMs: 5_000,
};

const COPY_BATCH = 200;
/** From this many mirrored paths on, a side that suddenly holds none is taken for lost. */
const EMPTY_GUARD_ENTRIES = 10;
const MAX_CONFLICTS = 50;
/** Failures in a row after which a step is set aside until the trees are next read in full. */
const MAX_STRIKES = 5;

type ScanReply = {
  entries: Array<[string, 'f' | 'd', number, number]>;
  links: number;
  gitDirty: boolean;
};
type RescanReply =
  | { full: true; gitDirty: boolean }
  | {
      full?: false;
      removed: string[];
      entries: Array<[string, 'f' | 'd', number, number]>;
      gitDirty: boolean;
    };
type StatReply = Array<[string, 'f' | 'd' | 'l' | 'o' | 'e' | null, number, number]>;
type CommitReply = Array<{ status: string; size?: number; mtimeMs?: number }>;
type GitReply = { code: number; stdout: string; stderr: string };
type GitStateReply =
  | { enabled: false }
  | {
      enabled: true;
      busy: boolean;
      head: { ref: string | null; oid: string | null };
      refs: RefMap;
    };

/** What a step that cannot go ahead looked like, so it is not tried again until it changes. */
function copyMark(op: CopyOp): string {
  return `copy:${op.from}:${op.source.size}:${op.source.mtimeMs}`;
}

function deleteMark(op: DeleteOp): string {
  return `delete:${op.side}:${op.expect.size}:${op.expect.mtimeMs}`;
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export class MirrorSession {
  private readonly timing: MirrorTiming;
  private agents: { a: MirrorAgent; b: MirrorAgent } | null = null;
  private readonly snapshots: Record<Side, Snapshot> = { a: new Map(), b: new Map() };
  private readonly needFull: Record<Side, boolean> = { a: true, b: true };
  private base: Base = new Map();
  private refsBase: RefMap | null = null;
  private headBase: string | null | undefined = undefined;
  /**
   * A new mirror's first pass has not run yet. In that pass side `a` is the truth for every
   * path the two sides never agreed on. It runs once: after it both sides are equals, except
   * for the paths in `seedPaths`.
   */
  private seedFirst: boolean;
  /** Paths the first pass could not finish, which stay "Windows is the truth" until they do. */
  private seedPaths = new Set<string>();
  private seededReported = false;
  /** The record of what both sides agreed on was lost: nothing is deleted until a clean round. */
  private merge = false;
  private stateLoaded = false;

  private stopped = false;
  private generation = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private cycleTimer: NodeJS.Timeout | null = null;
  private cycleDue = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private intervals: NodeJS.Timeout[] = [];
  private retries = 0;
  private restarts = 0;
  private stateDirty = false;
  private lastSavedAt = 0;
  private tempCounter = 0;

  private gitPending = true;
  private gitRetryAt = 0;
  private gitConfigured = false;
  /** Git state has not been brought in line yet on a new mirror: Windows is the truth. */
  private gitSeed: boolean;
  /** Side `a` is a Windows disk, whose git defaults the copy has to follow. */
  private windows = true;
  private degraded = false;

  /** Steps that cannot go ahead, by what they looked like; cleared whenever a tree is read in full. */
  private readonly blocked = new Map<string, string>();
  /** How often in a row a step failed for a reason that is not "the file changed again". */
  private readonly failures = new Map<string, { mark: string; count: number }>();
  private readonly branchConflicts = new Map<string, MirrorConflict>();
  private fileConflicts: MirrorConflict[] = [];
  private links = 0;
  private pending = 0;
  private gitNote: string | null = null;
  private phase: MirrorPhase = 'starting';
  private error: string | null = null;
  private lastSyncedAt: number | null = null;
  private idleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly options: MirrorSessionOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.seedFirst = options.seed;
    this.gitSeed = options.seed;
  }

  status(): MirrorStatus {
    let files = 0;
    for (const entry of this.base.values()) if (entry.kind === 'f') files += 1;
    return {
      phase: this.phase,
      files,
      pending: this.pending,
      lastSyncedAt: this.lastSyncedAt,
      conflicts: [...this.branchConflicts.values(), ...this.fileConflicts],
      links: this.links,
      gitNote: this.gitNote,
      error: this.error,
    };
  }

  start(): void {
    if (this.stopped) return;
    void this.connect();
  }

  /** Resolves once a round ends with nothing left to do; rejects when the mirror fails. */
  whenSynced(): Promise<void> {
    if (this.phase === 'synced') return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }

  /** Asks for a round now, reading both trees in full. */
  syncNow(): void {
    this.needFull.a = true;
    this.needFull.b = true;
    this.gitPending = true;
    this.gitRetryAt = 0;
    this.blocked.clear();
    this.failures.clear();
    this.kick(0);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    await this.running?.catch(() => {});
    await this.flushState();
    this.disconnect();
    this.setPhase('paused');
    this.rejectWaiters(new Error('The mirror was stopped.'));
  }

  // ── connection ───────────────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    const generation = (this.generation += 1);
    this.setPhase('starting');
    try {
      if (!this.stateLoaded) {
        const state = await this.options.loadState();
        if (state) this.restore(state);
        // A mirror that ran before but lost its record must not take absences for deletions.
        else if (!this.seedFirst) this.merge = true;
        this.stateLoaded = true;
      }
      const created = await this.options.createAgents();
      if (this.stopped || generation !== this.generation) {
        created.a.agent.dispose();
        created.b.agent.dispose();
        return;
      }
      const agents = { a: created.a.agent, b: created.b.agent };
      for (const side of ['a', 'b'] as const) {
        const agent = agents[side];
        agent.onEvent((event) => {
          if (generation !== this.generation) return;
          if (event.event === 'dirty') this.kick();
          else if (event.event === 'watch-degraded') this.degrade(side, event.error);
          else if (event.event === 'watch-error') {
            this.fail(new Error(event.error ?? 'Watching the folder stopped.'));
          }
        });
        agent.onExit((reason) => {
          if (generation === this.generation && !this.stopped) this.fail(new Error(reason));
        });
      }
      let onA: { platform: string };
      try {
        [onA] = await Promise.all([
          agents.a.request<{ platform: string }>('init', created.a.init),
          agents.b.request('init', created.b.init),
        ]);
      } catch (error) {
        agents.a.dispose();
        agents.b.dispose();
        throw error;
      }
      if (this.stopped || generation !== this.generation) {
        agents.a.dispose();
        agents.b.dispose();
        return;
      }
      // Only now can a round run: before `init` an agent knows no rules for what to leave out.
      this.agents = agents;
      this.windows = onA.platform === 'win32';
      this.needFull.a = true;
      this.needFull.b = true;
      this.gitPending = true;
      this.gitConfigured = false;
      this.intervals.push(
        setInterval(() => {
          this.needFull.a = true;
          this.needFull.b = true;
          this.kick();
        }, this.timing.fullScanMs),
        setInterval(() => {
          this.gitPending = true;
          this.kick();
        }, this.timing.gitCheckMs)
      );
      this.kick(0);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  private degrade(side: Side, reason: string | undefined): void {
    if (this.degraded) return;
    this.degraded = true;
    this.options.log?.warn('WSL mirror: watching is limited; reading the trees on a timer', {
      side,
      reason,
    });
    this.intervals.push(
      setInterval(() => {
        this.needFull.a = true;
        this.needFull.b = true;
        this.kick();
      }, this.timing.degradedScanMs)
    );
  }

  private disconnect(): void {
    this.generation += 1;
    for (const interval of this.intervals) clearInterval(interval);
    this.intervals = [];
    this.degraded = false;
    const agents = this.agents;
    this.agents = null;
    agents?.a.dispose();
    agents?.b.dispose();
  }

  private clearTimers(): void {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.cycleTimer = null;
    this.restartTimer = null;
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    this.options.log?.warn('WSL mirror: stopped by an error; it will start again', { message });
    this.clearTimers();
    this.disconnect();
    this.error = message;
    this.setPhase('error');
    this.rejectWaiters(new Error(message));
    const delay = Math.min(
      this.timing.restartMinMs * 2 ** Math.min(this.restarts, 6),
      this.timing.restartMaxMs
    );
    this.restarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.connect();
    }, delay);
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private setPhase(phase: MirrorPhase): void {
    if (phase !== 'error') this.error = phase === 'starting' ? this.error : null;
    this.phase = phase;
    this.options.onStatus?.(this.status());
    if (phase === 'synced') {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const waiter of waiters) waiter.resolve();
    }
  }

  // ── rounds ───────────────────────────────────────────────────────────────────────────────

  private kick(delay = this.timing.debounceMs): void {
    if (this.stopped || !this.agents) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const due = Date.now() + delay;
    if (this.cycleTimer) {
      // A round already waiting is only moved forward, never back.
      if (due >= this.cycleDue) return;
      clearTimeout(this.cycleTimer);
    }
    this.cycleDue = due;
    this.cycleTimer = setTimeout(() => {
      this.cycleTimer = null;
      this.runRound();
    }, delay);
  }

  private runRound(): void {
    if (this.stopped || !this.agents || this.running) return;
    const generation = this.generation;
    this.again = false;
    this.running = this.round().then(
      (unfinished) => {
        this.running = null;
        if (generation !== this.generation) return;
        this.restarts = 0;
        this.pending = unfinished;
        if (unfinished > 0) {
          const delay = Math.min(
            this.timing.retryMinMs * 2 ** Math.min(this.retries, 8),
            this.timing.retryMaxMs
          );
          this.retries += 1;
          this.setPhase(this.seeding() ? 'seeding' : 'syncing');
          this.kick(this.again ? this.timing.debounceMs : delay);
          return;
        }
        this.retries = 0;
        this.lastSyncedAt = Date.now();
        if (this.again) {
          this.kick();
          return;
        }
        // Files agree. Git state that had to wait is looked at again on its own.
        if (this.gitPending) this.kick(this.gitDelay());
        this.setPhase('synced');
      },
      (error: unknown) => {
        this.running = null;
        if (generation === this.generation) this.fail(error);
      }
    );
  }

  private gitDelay(): number {
    return Math.max(this.timing.debounceMs, this.gitRetryAt - Date.now());
  }

  private side(side: Side): MirrorAgent {
    if (!this.agents) throw new Error('The mirror is not connected.');
    return this.agents[side];
  }

  private async read(side: Side): Promise<void> {
    const agent = this.side(side);
    if (!this.needFull[side]) {
      const reply = await agent.request<RescanReply>('rescan');
      if (reply.gitDirty) this.gitPending = true;
      if (!reply.full) {
        applyRescan(this.snapshots[side], reply.removed, reply.entries);
        return;
      }
    }
    const reply = await agent.request<ScanReply>('scan');
    if (reply.gitDirty) this.gitPending = true;
    const snapshot: Snapshot = new Map();
    for (const [path, kind, size, mtimeMs] of reply.entries)
      snapshot.set(path, { kind, size, mtimeMs });
    this.snapshots[side] = snapshot;
    this.needFull[side] = false;
    // Whatever was in the way of a step may be gone by now.
    this.blocked.clear();
    this.failures.clear();
    if (side === 'a') this.links = reply.links;
  }

  /** One round. Returns how many changes it had to leave for the next one. */
  private async round(): Promise<number> {
    await Promise.all([this.read('a'), this.read('b')]);
    const { a, b } = this.snapshots;

    if (this.seeding() && this.phase !== 'seeding') this.setPhase('seeding');
    // An empty folder where there was a whole tree is a lost disk or a removed copy, not a
    // wish to delete everything on the other side. (Emptying a handful of files is.)
    let emptied: Side | null = null;
    if (this.seedFirst) {
      if (a.size === 0 && b.size > 0) emptied = 'a';
    } else if (this.base.size >= EMPTY_GUARD_ENTRIES) {
      if (a.size === 0) emptied = 'a';
      else if (b.size === 0) emptied = 'b';
    }
    if (emptied) {
      throw new Error(
        `The folder ${emptied === 'a' ? 'on Windows' : 'in the distro'} is empty or missing. ` +
          'Nothing was changed.'
      );
    }

    const first = this.seedFirst;
    const modeOf = (path: string): PlanMode => {
      if (first ? !this.base.has(path) : this.seedPaths.has(path)) return 'seed';
      return this.merge ? 'merge' : 'normal';
    };
    const plan = planMirror(this.base, a, b, modeOf);
    for (const path of plan.drops) this.dropBase(path);
    for (const [path, entry] of plan.agreed) this.setBase(path, entry);

    const failed: string[] = [];
    const copies: CopyOp[] = [...plan.copies];
    if (plan.compares.length > 0) {
      const paths = plan.compares.map((compare) => compare.path);
      const [hashesA, hashesB] = await Promise.all([
        this.side('a').request<Array<[string, string | null]>>('hash', { paths }),
        this.side('b').request<Array<[string, string | null]>>('hash', { paths }),
      ]);
      plan.compares.forEach((compare, index) => {
        const outcome = resolveCompare(
          compare,
          hashesA[index]?.[1] ?? null,
          hashesB[index]?.[1] ?? null,
          modeOf(compare.path)
        );
        if (outcome === 'agreed') {
          this.setBase(compare.path, { kind: 'f', a: compare.a, b: compare.b });
        } else if (outcome === 'unreadable') failed.push(compare.path);
        else copies.push(outcome);
      });
    }

    const checked = await this.checkAgainstDisk(copies, plan.deletes);
    failed.push(...checked.waiting);
    const when = stamp(new Date());
    const working = checked.copies.length + checked.deletes.length + plan.rmdirs.length;
    if (working > 0 && !this.seeding() && this.phase !== 'syncing') this.setPhase('syncing');

    await this.makeDirectories(plan.mkdirs);
    failed.push(...(await this.copy(checked.copies, when)));
    failed.push(...(await this.remove(checked.deletes, when)));
    await this.removeDirectories(plan.rmdirs);
    for (const path of plan.typeConflicts) this.noteConflict({ path, kind: 'type', kept: 'both' });

    // The first pass is over, whatever it left. Only what it could not finish stays planned
    // with Windows as the truth; everything else is between equals from here on, so work done
    // in the distro meanwhile is never taken for something to undo.
    const unfinished = new Set(failed);
    this.seedFirst = false;
    this.seedPaths = new Set(
      [...(first ? unfinished : this.seedPaths)].filter(
        (path) => unfinished.has(path) || this.blocked.has(path)
      )
    );
    if (unfinished.size === 0) this.merge = false;
    if (!this.seededReported && ![...this.seedPaths].some((path) => !this.blocked.has(path))) {
      this.seededReported = true;
      if (this.options.seed) await this.options.onSeeded?.();
    }

    if (this.gitPending && Date.now() >= this.gitRetryAt) await this.syncGit();
    this.scheduleSave();
    return unfinished.size;
  }

  /** The mirror is still on its first run, in whole or for the paths that run left open. */
  private seeding(): boolean {
    return this.seedFirst || [...this.seedPaths].some((path) => !this.blocked.has(path));
  }

  private setBase(path: string, entry: BaseEntry): void {
    this.base.set(path, entry);
    this.stateDirty = true;
  }

  private dropBase(path: string): void {
    if (this.base.delete(path)) this.stateDirty = true;
  }

  private noteConflict(conflict: Omit<MirrorConflict, 'at'>): void {
    // A standing conflict is reported once, not on every round that still sees it.
    if (
      conflict.kind !== 'file' &&
      this.fileConflicts.some(
        (known) => known.kind === conflict.kind && known.path === conflict.path
      )
    ) {
      return;
    }
    this.fileConflicts = [
      { ...conflict, at: Date.now() },
      ...this.fileConflicts.filter((known) => known.path !== conflict.path),
    ].slice(0, MAX_CONFLICTS);
    this.options.log?.warn('WSL mirror: conflict', conflict);
  }

  /**
   * The last check before anything is created or removed. A file is only deleted when the
   * other side really has no file there, and only created where nothing is in the way: a side
   * may hold files the mirror does not see, because its own git ignores them.
   */
  private async checkAgainstDisk(
    copies: CopyOp[],
    deletes: DeleteOp[]
  ): Promise<{ copies: CopyOp[]; deletes: DeleteOp[]; waiting: string[] }> {
    const ask: Record<Side, string[]> = { a: [], b: [] };
    const open = copies.filter((op) => !this.isBlocked(op.path, copyMark(op)));
    const wanted = deletes.filter((op) => !this.isBlocked(op.path, deleteMark(op)));
    for (const op of open) if (op.expect === null) ask[op.from === 'a' ? 'b' : 'a'].push(op.path);
    for (const op of wanted) ask[op.side === 'a' ? 'b' : 'a'].push(op.path);
    if (ask.a.length === 0 && ask.b.length === 0) {
      return { copies: open, deletes: wanted, waiting: [] };
    }

    const [onA, onB] = await Promise.all(
      (['a', 'b'] as const).map(async (side) => {
        const found = new Map<string, string | null>();
        if (ask[side].length === 0) return found;
        const reply = await this.side(side).request<StatReply>('stat', { paths: ask[side] });
        for (const [path, kind] of reply) found.set(path, kind);
        return found;
      })
    );
    const found: Record<Side, Map<string, string | null>> = { a: onA, b: onB };

    const waiting: string[] = [];
    const keptCopies = open.filter((op) => {
      if (op.expect !== null) return true;
      const there = found[op.from === 'a' ? 'b' : 'a'].get(op.path) ?? null;
      if (there === null) return true;
      if (there === 'c') {
        // A file of the same name in other case is in the way on a disk that ignores case.
        // If that is the old name of a rename, it goes this round and the copy follows.
        this.strike(op.path, copyMark(op), op.from === 'a' ? 'windows' : 'wsl');
        if (!this.blocked.has(op.path)) waiting.push(op.path);
        return false;
      }
      this.blocked.set(op.path, copyMark(op));
      return false;
    });
    const keptDeletes = wanted.filter((op) => {
      const there = found[op.side === 'a' ? 'b' : 'a'].get(op.path) ?? null;
      // A folder there, or only a name in other case, is not this file.
      if (there === null || there === 'd' || there === 'c') return true;
      // It is still there, only not mirrored: forget the path rather than delete its twin.
      this.blocked.set(op.path, deleteMark(op));
      this.dropBase(op.path);
      return false;
    });
    return { copies: keptCopies, deletes: keptDeletes, waiting };
  }

  /**
   * Counts a failure that is not "the file changed again". A step that keeps failing (a name
   * Windows cannot hold, a file held open for good) is set aside and reported, so the rest of
   * the mirror can be in sync; it is tried again after the next full read of the trees.
   */
  private strike(path: string, mark: string, kept: 'windows' | 'wsl'): void {
    const known = this.failures.get(path);
    const count = known?.mark === mark ? known.count + 1 : 1;
    this.failures.set(path, { mark, count });
    if (count < MAX_STRIKES) return;
    this.blocked.set(path, mark);
    this.noteConflict({ path, kind: 'stuck', kept });
  }

  /** True while a step is known not to be possible. Any other step for the path clears it. */
  private isBlocked(path: string, mark: string): boolean {
    const known = this.blocked.get(path);
    if (known === undefined) return false;
    if (known === mark) return true;
    this.blocked.delete(path);
    return false;
  }

  private async makeDirectories(ops: DirOp[]): Promise<void> {
    for (const side of ['a', 'b'] as const) {
      const paths = ops.filter((op) => op.side === side).map((op) => op.path);
      if (paths.length === 0) continue;
      const results = await this.side(side).request<string[]>('mkdir', { paths });
      paths.forEach((path, index) => {
        if (results[index] !== 'ok') return;
        this.snapshots[side].set(path, { kind: 'd', size: 0, mtimeMs: 0 });
        this.setBase(path, { kind: 'd' });
      });
    }
  }

  private async copy(ops: CopyOp[], when: string): Promise<string[]> {
    const unfinished: string[] = [];
    const stale: Record<Side, string[]> = { a: [], b: [] };
    // `changed` means the file moved on and the next round plans afresh; anything else is a
    // failure of the step itself.
    const left = (op: CopyOp, side: Side, status: string | undefined) => {
      stale[side].push(op.path);
      if (status !== 'changed')
        this.strike(op.path, copyMark(op), op.from === 'a' ? 'windows' : 'wsl');
      if (!this.blocked.has(op.path)) unfinished.push(op.path);
    };
    for (let start = 0; start < ops.length; start += COPY_BATCH) {
      const batch = ops.slice(start, start + COPY_BATCH).map((op) => {
        this.tempCounter += 1;
        return { op, tmp: `.~mirror-${process.pid}-${this.tempCounter}.tmp` };
      });
      const toA = batch.filter((item) => item.op.from === 'b');
      const toB = batch.filter((item) => item.op.from === 'a');

      // `b` reads both ways: its own files into `a`'s folder, and `a`'s files into its own.
      const staged = await this.side('b').request<{ toPeer: string[]; fromPeer: string[] }>(
        'stage',
        {
          toPeer: toA.map(({ op, tmp }) => ({ path: op.path, tmp, ...op.source })),
          fromPeer: toB.map(({ op, tmp }) => ({ path: op.path, tmp })),
        }
      );

      const readyForA = toA.filter((item, index) => {
        if (staged.toPeer[index] === 'ok') return true;
        left(item.op, 'b', staged.toPeer[index]);
        return false;
      });
      const fetched = toB.filter((item, index) => {
        if (staged.fromPeer[index] === 'ok') return true;
        left(item.op, 'a', staged.fromPeer[index]);
        return false;
      });

      // What `b` read from `a` is only good if `a`'s file is still the one the plan saw.
      const readyForB: typeof fetched = [];
      if (fetched.length > 0) {
        const now = await this.side('a').request<StatReply>('stat', {
          paths: fetched.map((item) => item.op.path),
        });
        const moved: typeof fetched = [];
        fetched.forEach((item, index) => {
          const [, kind, size, mtimeMs] = now[index] ?? [item.op.path, null, 0, 0];
          const unchanged =
            kind === 'f' && size === item.op.source.size && mtimeMs === item.op.source.mtimeMs;
          (unchanged ? readyForB : moved).push(item);
        });
        if (moved.length > 0) {
          await this.side('b').request('discard', {
            items: moved.map(({ op, tmp }) => ({ path: op.path, tmp })),
          });
          for (const item of moved) left(item.op, 'a', 'changed');
        }
      }

      for (const [side, ready] of [
        ['a', readyForA],
        ['b', readyForB],
      ] as const) {
        if (ready.length === 0) continue;
        const results = await this.side(side).request<CommitReply>('commit', {
          stamp: when,
          items: ready.map(({ op, tmp }) => ({
            path: op.path,
            tmp,
            expect: op.expect,
            mtimeMs: op.source.mtimeMs,
            backup: op.backup,
          })),
        });
        ready.forEach(({ op }, index) => {
          const result = results[index];
          if (
            result?.status !== 'ok' ||
            result.size === undefined ||
            result.mtimeMs === undefined
          ) {
            left(op, side, result?.status);
            return;
          }
          this.failures.delete(op.path);
          const placed: FileStat = { size: result.size, mtimeMs: result.mtimeMs };
          this.snapshots[side].set(op.path, { kind: 'f', ...placed });
          this.setBase(op.path, {
            kind: 'f',
            a: side === 'a' ? placed : op.source,
            b: side === 'b' ? placed : op.source,
          });
          if (op.conflict) {
            this.noteConflict({
              path: op.path,
              kind: 'file',
              kept: op.from === 'a' ? 'windows' : 'wsl',
            });
          }
        });
      }
    }
    await this.reread(stale);
    return unfinished;
  }

  private async remove(ops: DeleteOp[], when: string): Promise<string[]> {
    const unfinished: string[] = [];
    const stale: Record<Side, string[]> = { a: [], b: [] };
    for (const side of ['a', 'b'] as const) {
      const mine = ops.filter((op) => op.side === side);
      if (mine.length === 0) continue;
      const results = await this.side(side).request<string[]>('remove', {
        stamp: when,
        items: mine.map((op) => ({ path: op.path, kind: 'f', keep: op.keep, ...op.expect })),
      });
      mine.forEach((op, index) => {
        const result = results[index];
        if (result === 'ok' || result === 'gone') {
          this.failures.delete(op.path);
          this.snapshots[side].delete(op.path);
          this.dropBase(op.path);
        } else {
          stale[side].push(op.path);
          if (result !== 'changed') {
            this.strike(op.path, deleteMark(op), side === 'a' ? 'windows' : 'wsl');
          }
          if (!this.blocked.has(op.path)) unfinished.push(op.path);
        }
      });
    }
    await this.reread(stale);
    return unfinished;
  }

  private async removeDirectories(ops: DirOp[]): Promise<void> {
    for (const op of ops) {
      const [result] = await this.side(op.side).request<string[]>('remove', {
        stamp: '',
        items: [{ path: op.path, kind: 'd' }],
      });
      // A folder that still holds something of its own (build output, say) stays, and is
      // tried again in later rounds; it is not put back on the side that removed it.
      if (result !== 'ok' && result !== 'gone') continue;
      this.snapshots[op.side].delete(op.path);
      this.dropBase(op.path);
    }
  }

  /** Reads single paths again after a step found them different from what the plan saw. */
  private async reread(stale: Record<Side, string[]>): Promise<void> {
    for (const side of ['a', 'b'] as const) {
      if (stale[side].length === 0) continue;
      const reply = await this.side(side).request<StatReply>('stat', { paths: stale[side] });
      for (const [path, kind, size, mtimeMs] of reply) {
        if (kind === 'f' || kind === 'd') this.snapshots[side].set(path, { kind, size, mtimeMs });
        else if (kind === null) applyRescan(this.snapshots[side], [path], []);
      }
    }
  }

  // ── git ──────────────────────────────────────────────────────────────────────────────────

  private async git(side: Side, args: string[], input?: string): Promise<GitReply> {
    return this.side(side).request<GitReply>('git', { args, input });
  }

  private async gitOk(side: Side, args: string[], input?: string): Promise<string> {
    const reply = await this.git(side, args, input);
    if (reply.code !== 0) {
      throw new Error(`git ${args[0]} failed: ${reply.stderr.trim() || `code ${reply.code}`}`);
    }
    return reply.stdout;
  }

  private async syncGit(): Promise<void> {
    try {
      const done = await this.syncGitState();
      if (done) {
        this.gitPending = false;
        this.gitRetryAt = 0;
      } else this.gitRetryAt = Date.now() + 2_000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.warn('WSL mirror: git state could not be mirrored; trying again', {
        message,
      });
      this.gitNote = message;
      this.gitRetryAt = Date.now() + 15_000;
    }
  }

  /**
   * The copy in the distro has to read the working tree the way git on Windows does, or every
   * file would look modified there: the same line-ending settings, and no file modes or
   * symbolic links, which a Windows disk does not keep.
   */
  private async configureGit(): Promise<void> {
    const read = async (key: string) =>
      (await this.git('a', ['config', '--get', key])).stdout.trim();
    const [autocrlf, eol, symlinks] = await Promise.all([
      read('core.autocrlf'),
      read('core.eol'),
      read('core.symlinks'),
    ]);
    const settings: Array<[string, string]> = [
      ['core.autocrlf', autocrlf || 'false'],
      ['core.eol', eol && eol !== 'native' ? eol : this.windows ? 'crlf' : 'lf'],
      ['core.symlinks', symlinks || (this.windows ? 'false' : 'true')],
      ['core.filemode', 'false'],
    ];
    for (const [key, value] of settings) await this.gitOk('b', ['config', '--local', key, value]);
    this.gitConfigured = true;
  }

  /** Returns false when a git operation is in progress and the state should be left alone. */
  private async syncGitState(): Promise<boolean> {
    const [stateA, stateB] = await Promise.all([
      this.side('a').request<GitStateReply>('gitState'),
      this.side('b').request<GitStateReply>('gitState'),
    ]);
    if (!stateA.enabled || !stateB.enabled) {
      this.gitNote =
        stateA.enabled === stateB.enabled
          ? null
          : 'Only one side is a git repository, so branches and commits are not mirrored.';
      return true;
    }
    if (stateA.busy || stateB.busy) return false;
    if (!this.gitConfigured) await this.configureGit();

    const plan = planRefs(this.refsBase, stateA.refs, stateB.refs, this.gitSeed);
    const headA = headValue(stateA.head);
    const headB = headValue(stateB.head);
    // Between equals the distro's HEAD stands, since that is where the agents work; a mirror
    // that never agreed on one takes the Windows folder's.
    const head = planHead(this.headBase, headA, headB, this.headBase === undefined ? 'a' : 'b');

    const detached = (value: string | undefined) =>
      value?.startsWith('oid:') ? [value.slice(4)] : [];
    const needA = [
      ...plan.setA.flatMap((update) => (update.to ? [update.to] : [])),
      ...plan.contested.map((contested) => contested.b),
      ...detached(head?.side === 'a' ? head.to : undefined),
    ];
    const needB = [
      ...plan.setB.flatMap((update) => (update.to ? [update.to] : [])),
      ...plan.contested.map((contested) => contested.a),
      ...detached(head?.side === 'b' ? head.to : undefined),
    ];
    await this.transfer('b', 'a', needA, stateA.refs);
    await this.transfer('a', 'b', needB, stateB.refs);

    // A branch is not deleted from under a HEAD: where either side has it checked out, the
    // deletion waits until that side has moved off it.
    const checkedOut = new Set([stateA.head.ref, stateB.head.ref]);
    const applies = (update: RefUpdate) => update.to !== null || !checkedOut.has(update.ref);
    const setA: RefUpdate[] = plan.setA.filter(applies);
    const setB: RefUpdate[] = plan.setB.filter(applies);
    const keepA: RefUpdate[] = [];
    const keepB: RefUpdate[] = [];
    const conflicted = new Set<string>();
    for (const contested of plan.contested) {
      const ancestry = await this.ancestry(contested.a, contested.b);
      // On a first run the Windows folder's files stand, so its branch is not moved forward
      // to commits those files do not hold: that is reported like any other divergence.
      const settled = settleRef(
        contested,
        this.gitSeed && ancestry === 'a-behind' ? 'diverged' : ancestry
      );
      if (settled === 'conflict') {
        conflicted.add(contested.ref);
        // Each side keeps its own branch and gets the other's commits under a name of its own.
        const name = `refs/maestro-mirror/conflict/${contested.ref.slice('refs/'.length)}`;
        keepA.push({ ref: name, to: contested.b, from: null });
        keepB.push({ ref: name, to: contested.a, from: null });
        if (!this.branchConflicts.has(contested.ref)) {
          this.branchConflicts.set(contested.ref, {
            path: contested.ref.replace(/^refs\/heads\//, ''),
            kind: 'branch',
            kept: 'both',
            at: Date.now(),
          });
          this.options.log?.warn('WSL mirror: a branch has different commits on each side', {
            ref: contested.ref,
          });
        }
      } else (settled.side === 'a' ? setA : setB).push(settled.update);
    }
    for (const ref of this.branchConflicts.keys()) {
      if (!conflicted.has(ref)) this.branchConflicts.delete(ref);
    }

    await this.applyGit('a', stateA, setA, keepA, head?.side === 'a' ? head.to : null);
    await this.applyGit('b', stateB, setB, keepB, head?.side === 'b' ? head.to : null);

    const finalA = applyRefUpdates(stateA.refs, setA);
    const finalB = applyRefUpdates(stateB.refs, setB);
    this.refsBase = agreedRefs(this.refsBase, finalA, finalB);
    const finalHeadA = head?.side === 'a' ? head.to : headA;
    const finalHeadB = head?.side === 'b' ? head.to : headB;
    if (finalHeadA === finalHeadB) this.headBase = finalHeadA;
    this.gitSeed = false;
    this.stateDirty = true;
    this.gitNote = null;
    return true;
  }

  private async ancestry(a: string, b: string): Promise<Ancestry> {
    if ((await this.git('b', ['merge-base', '--is-ancestor', a, b])).code === 0) return 'a-behind';
    if ((await this.git('b', ['merge-base', '--is-ancestor', b, a])).code === 0) return 'b-behind';
    return 'diverged';
  }

  /** Carries the commits `to` lacks across in a bundle, written and read by git on each side. */
  private async transfer(from: Side, to: Side, wanted: string[], toRefs: RefMap): Promise<void> {
    const unique = [...new Set(wanted)];
    if (unique.length === 0) return;
    const lacking = (output: string) =>
      output
        .split('\n')
        .filter((line) => line.endsWith(' missing'))
        .map((line) => line.slice(0, line.indexOf(' ')));
    const missing = lacking(
      (await this.git(to, ['cat-file', '--batch-check'], `${unique.join('\n')}\n`)).stdout
    );
    if (missing.length === 0) return;

    // What `to` already has is left out of the bundle, as far as `from` knows those commits.
    const theirs = [...new Set(Object.values(toRefs))].slice(0, 4000);
    let shared: string[] = [];
    if (theirs.length > 0) {
      const absent = new Set(
        lacking(
          (await this.git(from, ['cat-file', '--batch-check'], `${theirs.join('\n')}\n`)).stdout
        )
      );
      shared = theirs.filter((oid) => !absent.has(oid));
    }
    const outgoing = missing.map((_oid, index) => `refs/maestro-mirror/out/${index}`);
    const name = `objects-${process.pid}-${Date.now()}.bundle`;
    // The bundle always lives in `a`'s folder, which is the one both sides can reach.
    const file = (side: Side) => `${side === 'a' ? '{mirrorDir}' : '{peerMirrorDir}'}/${name}`;
    try {
      await this.gitOk(
        from,
        ['update-ref', '--stdin'],
        missing.map((oid, index) => `update ${outgoing[index]} ${oid}\n`).join('')
      );
      await this.gitOk(
        from,
        ['bundle', 'create', file(from), '--stdin'],
        `${[...outgoing, ...shared.map((oid) => `^${oid}`)].join('\n')}\n`
      );
      await this.gitOk(to, ['bundle', 'unbundle', file(to)]);
    } finally {
      await this.git(
        from,
        ['update-ref', '--stdin'],
        outgoing.map((ref) => `delete ${ref}\n`).join('')
      );
      await this.side('a').request('dropMirrorFile', { name });
    }
  }

  private async applyGit(
    side: Side,
    state: Extract<GitStateReply, { enabled: true }>,
    updates: RefUpdate[],
    keep: RefUpdate[],
    head: string | null
  ): Promise<void> {
    if (updates.length === 0 && keep.length === 0 && head === null) return;
    if (updates.length > 0) {
      await this.gitOk(
        side,
        ['update-ref', '-m', 'maestro mirror', '--stdin'],
        updateRefInput(updates)
      );
    }
    if (keep.length > 0) {
      await this.gitOk(
        side,
        ['update-ref', '--stdin'],
        keep.map((update) => `update ${update.ref} ${update.to}\n`).join('')
      );
    }
    if (head?.startsWith('ref:')) {
      await this.gitOk(side, ['symbolic-ref', '-m', 'maestro mirror', 'HEAD', head.slice(4)]);
    } else if (head?.startsWith('oid:')) {
      await this.gitOk(side, [
        'update-ref',
        '--no-deref',
        '-m',
        'maestro mirror',
        'HEAD',
        head.slice(4),
      ]);
    }

    // The working tree already holds the other side's files. Moving the index from the old
    // commit to the new one keeps `git status` true without touching a file, and keeps
    // whatever was staged here; when that cannot be merged, the index is rebuilt.
    const now = await this.git(side, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
    const next = now.code === 0 ? now.stdout.trim() : null;
    if (next === null || next === state.head.oid) return;
    const merged =
      state.head.oid === null
        ? { code: 1 }
        : await this.git(side, ['read-tree', '-i', '-m', state.head.oid, next]);
    if (merged.code !== 0) await this.gitOk(side, ['read-tree', next]);
  }

  // ── remembered state ─────────────────────────────────────────────────────────────────────

  private restore(state: MirrorState): void {
    this.base = new Map();
    for (const path of state.dirs) this.base.set(path, { kind: 'd' });
    for (const [path, sizeA, timeA, sizeB, timeB] of state.files) {
      this.base.set(path, {
        kind: 'f',
        a: { size: sizeA, mtimeMs: timeA },
        b: { size: sizeB, mtimeMs: timeB },
      });
    }
    this.refsBase = state.refs;
    // Files were brought in line before the app closed, git state was not: it still has to be.
    if (state.gitSeeded === false) this.gitSeed = true;
    this.headBase = state.head;
  }

  private snapshotState(): MirrorState {
    const files: MirrorState['files'] = [];
    const dirs: string[] = [];
    for (const [path, entry] of this.base) {
      if (entry.kind === 'd') dirs.push(path);
      else files.push([path, entry.a.size, entry.a.mtimeMs, entry.b.size, entry.b.mtimeMs]);
    }
    return {
      version: 1,
      gitSeeded: !this.gitSeed,
      files,
      dirs,
      refs: this.refsBase,
      ...(this.headBase === undefined ? {} : { head: this.headBase }),
    };
  }

  private scheduleSave(): void {
    if (!this.stateDirty || this.saveTimer) return;
    const wait = Math.max(0, this.lastSavedAt + this.timing.saveMs - Date.now());
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushState();
    }, wait);
  }

  private async flushState(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // A mirror still being seeded has no agreed state worth keeping: it starts over instead.
    if (!this.stateDirty || this.seedFirst) return;
    this.stateDirty = false;
    this.lastSavedAt = Date.now();
    try {
      await this.options.saveState(this.snapshotState());
    } catch (error) {
      this.stateDirty = true;
      this.options.log?.warn('WSL mirror: its record could not be saved', { error: String(error) });
    }
  }
}
