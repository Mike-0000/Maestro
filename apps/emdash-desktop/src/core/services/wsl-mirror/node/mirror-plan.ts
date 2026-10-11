/**
 * Deciding what a mirror has to do, from three pictures of the same tree: side `a` (the Windows
 * folder), side `b` (its copy in the distro), and the base, which is what both held when they
 * last agreed. A path that differs from the base on one side only changed there, and the change
 * is carried over. A path that changed on both sides is a conflict, settled without losing
 * either version.
 *
 * Everything here is pure. The session checks each step against the disk again before it acts.
 */

export type Side = 'a' | 'b';

export type FileStat = { readonly size: number; readonly mtimeMs: number };

export type SnapshotEntry = { readonly kind: 'f' | 'd' } & FileStat;

/** One side's tree: path (with `/`) to what is there. */
export type Snapshot = Map<string, SnapshotEntry>;

export type BaseEntry =
  | { readonly kind: 'd' }
  | { readonly kind: 'f'; readonly a: FileStat; readonly b: FileStat };

export type Base = Map<string, BaseEntry>;

/**
 * - `normal`: both sides are equals and the base says who changed what.
 * - `seed`: the first run of a new mirror. Side `a` is the truth and `b` is made to match it.
 * - `merge`: the base was lost. Nothing is deleted; differing files are settled as conflicts.
 */
export type PlanMode = 'normal' | 'seed' | 'merge';

export type CopyOp = {
  readonly path: string;
  readonly from: Side;
  /** The source as the plan saw it. */
  readonly source: FileStat;
  /** The destination as the plan saw it; null when there must be nothing there. */
  readonly expect: FileStat | null;
  /** Keep the replaced file: it holds changes the copy does not. */
  readonly backup: boolean;
  readonly conflict: boolean;
};

export type DeleteOp = {
  readonly path: string;
  readonly side: Side;
  readonly expect: FileStat;
  /** Move the file aside even where there is no trash to move it to. */
  readonly keep?: boolean;
};

export type DirOp = { readonly path: string; readonly side: Side };

/** A file both sides changed to the same size: only its contents can tell whether they agree. */
export type Compare = { readonly path: string; readonly a: FileStat; readonly b: FileStat };

export type Plan = {
  readonly mkdirs: DirOp[];
  readonly copies: CopyOp[];
  readonly compares: Compare[];
  readonly deletes: DeleteOp[];
  /** Deepest first. A folder that still holds something is left alone. */
  readonly rmdirs: DirOp[];
  /** Base entries to write as they are: both sides already agree. */
  readonly agreed: Array<[string, BaseEntry]>;
  /** Base entries for paths that are gone from both sides. */
  readonly drops: string[];
  /** A file on one side and a folder on the other, with nothing to say which came first. */
  readonly typeConflicts: string[];
};

function same(a: FileStat, b: FileStat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function stat(entry: SnapshotEntry): FileStat {
  return { size: entry.size, mtimeMs: entry.mtimeMs };
}

function other(side: Side): Side {
  return side === 'a' ? 'b' : 'a';
}

/** The copy that settles two differing versions: which one stays, and that the other is kept. */
export function settle(path: string, a: FileStat, b: FileStat, mode: PlanMode): CopyOp {
  const from: Side = mode === 'seed' || a.mtimeMs >= b.mtimeMs ? 'a' : 'b';
  return {
    path,
    from,
    source: from === 'a' ? a : b,
    expect: from === 'a' ? b : a,
    backup: true,
    conflict: mode !== 'seed',
  };
}

/** `modes` is one mode for the whole tree, or the mode each path is planned in. */
export function planMirror(
  base: Base,
  a: Snapshot,
  b: Snapshot,
  modes: PlanMode | ((path: string) => PlanMode)
): Plan {
  const modeOf = typeof modes === 'function' ? modes : () => modes;
  const plan: Plan = {
    mkdirs: [],
    copies: [],
    compares: [],
    deletes: [],
    rmdirs: [],
    agreed: [],
    drops: [],
    typeConflicts: [],
  };
  const paths = new Set<string>([...base.keys(), ...a.keys(), ...b.keys()]);

  for (const path of paths) {
    const mode = modeOf(path);
    const inBase = base.get(path);
    const onA = a.get(path);
    const onB = b.get(path);
    const dirA = onA?.kind === 'd';
    const dirB = onB?.kind === 'd';
    const fileA = onA?.kind === 'f' ? onA : undefined;
    const fileB = onB?.kind === 'f' ? onB : undefined;

    if (!onA && !onB) {
      plan.drops.push(path);
      continue;
    }

    // Folders.
    if (dirA && dirB) {
      if (inBase?.kind !== 'd') plan.agreed.push([path, { kind: 'd' }]);
      continue;
    }
    if (dirA || dirB) {
      const has: Side = dirA ? 'a' : 'b';
      const lacks = other(has);
      const fileOnOther = has === 'a' ? fileB : fileA;
      if (fileOnOther) {
        // The folder was a folder on both sides and one turned it into a file: the folder
        // goes once it is empty, and the file follows in a later round.
        // The other way round, an untouched file gives way to the new folder.
        if (inBase?.kind === 'd') plan.rmdirs.push({ path, side: has });
        else if (inBase?.kind === 'f' && same(fileOnOther, inBase[lacks])) {
          plan.deletes.push({ path, side: lacks, expect: stat(fileOnOther) });
        } else plan.typeConflicts.push(path);
        continue;
      }
      const removedThere =
        mode === 'seed' ? has === 'b' : mode === 'normal' && inBase?.kind === 'd';
      if (removedThere) plan.rmdirs.push({ path, side: has });
      else plan.mkdirs.push({ path, side: lacks });
      continue;
    }

    // Files.
    const baseFile = inBase?.kind === 'f' ? inBase : undefined;
    if (fileA && fileB) {
      const sameA = baseFile ? same(fileA, baseFile.a) : false;
      const sameB = baseFile ? same(fileB, baseFile.b) : false;
      if (sameA && sameB) continue;
      if (baseFile && sameB) {
        plan.copies.push({
          path,
          from: 'a',
          source: stat(fileA),
          expect: stat(fileB),
          backup: false,
          conflict: false,
        });
      } else if (baseFile && sameA && mode !== 'seed') {
        plan.copies.push({
          path,
          from: 'b',
          source: stat(fileB),
          expect: stat(fileA),
          backup: false,
          conflict: false,
        });
      } else if (fileA.size !== fileB.size) {
        plan.copies.push(settle(path, stat(fileA), stat(fileB), mode));
      } else {
        plan.compares.push({ path, a: stat(fileA), b: stat(fileB) });
      }
      continue;
    }

    const only: Side = fileA ? 'a' : 'b';
    const file = (fileA ?? fileB) as SnapshotEntry;
    const baseStat = baseFile ? baseFile[only] : undefined;
    const untouched = baseStat ? same(file, baseStat) : false;
    // Gone from the other side, and unchanged here since both agreed: it was deleted there.
    const deletedThere =
      mode === 'seed' ? only === 'b' : mode === 'normal' && baseFile !== undefined && untouched;
    if (deletedThere) {
      // On a first run nothing says the file exists anywhere else, so it is never destroyed.
      plan.deletes.push({ path, side: only, expect: stat(file), keep: mode === 'seed' });
    } else {
      plan.copies.push({
        path,
        from: only,
        source: stat(file),
        expect: null,
        backup: false,
        conflict: false,
      });
    }
  }

  plan.rmdirs.sort((x, y) => y.path.length - x.path.length);
  plan.mkdirs.sort((x, y) => x.path.length - y.path.length);
  return plan;
}

/** What to do about a compared file, given both sides' content hashes. Null: they agree. */
export function resolveCompare(
  compare: Compare,
  hashA: string | null,
  hashB: string | null,
  mode: PlanMode
): CopyOp | 'agreed' | 'unreadable' {
  if (hashA === null || hashB === null) return 'unreadable';
  if (hashA === hashB) return 'agreed';
  return settle(compare.path, compare.a, compare.b, mode);
}

/** Applies a rescan to a snapshot: removed paths take everything under them along. */
export function applyRescan(
  snapshot: Snapshot,
  removed: readonly string[],
  entries: ReadonlyArray<readonly [string, 'f' | 'd', number, number]>
): void {
  if (removed.length > 0) {
    const gone = new Set(removed);
    const prefixes = removed.map((path) => `${path}/`);
    for (const key of snapshot.keys()) {
      if (gone.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) snapshot.delete(key);
    }
  }
  for (const [path, kind, size, mtimeMs] of entries) snapshot.set(path, { kind, size, mtimeMs });
}
