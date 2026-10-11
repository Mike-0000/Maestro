import type { Side } from './mirror-plan';

/**
 * Keeping two repositories' branches, tags and HEAD in step. Each side has its own `.git`; only
 * objects and ref values cross, through git itself. As with files, the base (the values both
 * sides last agreed on) says which side moved a ref.
 */

/** Ref name to object id. */
export type RefMap = Record<string, string>;

export type RefUpdate = {
  readonly ref: string;
  /** The value to set; null deletes the ref. */
  readonly to: string | null;
  /** The value the side holds now, which the update is conditional on; null when absent. */
  readonly from: string | null;
};

/** A ref both sides moved, or that has no base to say who did. */
export type ContestedRef = { readonly ref: string; readonly a: string; readonly b: string };

export type RefPlan = {
  readonly setA: RefUpdate[];
  readonly setB: RefUpdate[];
  readonly contested: ContestedRef[];
};

/**
 * With `seed`, side `a` is the truth for what is only a copy of something else, as on a
 * mirror's first run: `b` takes `a`'s tags and remote-tracking refs, and remote-tracking refs
 * only `b` has are dropped. (A fresh clone of the Windows folder holds that folder's branches
 * under `refs/remotes`, which says nothing about the real remote.) Branches are never
 * overwritten: one only `b` has is kept, and one that differs is contested.
 */
export function planRefs(base: RefMap | null, a: RefMap, b: RefMap, seed = false): RefPlan {
  const plan: RefPlan = { setA: [], setB: [], contested: [] };
  const names = new Set([...Object.keys(base ?? {}), ...Object.keys(a), ...Object.keys(b)]);
  for (const ref of names) {
    const onA = a[ref] ?? null;
    const onB = b[ref] ?? null;
    if (onA === onB) continue;
    if (seed) {
      // A branch both sides have at different commits may hold work on either: it is settled
      // by ancestry like any other, and never simply overwritten.
      if (onA !== null && onB !== null && ref.startsWith('refs/heads/')) {
        plan.contested.push({ ref, a: onA, b: onB });
      } else if (onA !== null) plan.setB.push({ ref, to: onA, from: onB });
      else if (ref.startsWith('refs/remotes/')) plan.setB.push({ ref, to: null, from: onB });
      else plan.setA.push({ ref, to: onB, from: null });
      continue;
    }
    const before = base ? (base[ref] ?? null) : undefined;
    if (before !== undefined && onB === before) {
      plan.setB.push({ ref, to: onA, from: onB });
    } else if (before !== undefined && onA === before) {
      plan.setA.push({ ref, to: onB, from: onA });
    } else if (onA === null) {
      // Deleted on one side and moved on the other, or simply unknown there: it is kept.
      plan.setA.push({ ref, to: onB, from: null });
    } else if (onB === null) {
      plan.setB.push({ ref, to: onA, from: null });
    } else {
      plan.contested.push({ ref, a: onA, b: onB });
    }
  }
  return plan;
}

/** How two commits of a contested ref relate, as `git merge-base --is-ancestor` reports it. */
export type Ancestry = 'a-behind' | 'b-behind' | 'diverged';

/**
 * Settles a contested ref. The side that is merely behind is moved forward. A branch that has
 * different commits on each side is left alone on both and reported; for tags and
 * remote-tracking refs, which are copies of something elsewhere, side `b` is taken.
 */
export function settleRef(
  contested: ContestedRef,
  ancestry: Ancestry
): { side: Side; update: RefUpdate } | 'conflict' {
  const { ref, a, b } = contested;
  if (ancestry === 'a-behind') return { side: 'a', update: { ref, to: b, from: a } };
  if (ancestry === 'b-behind') return { side: 'b', update: { ref, to: a, from: b } };
  if (ref.startsWith('refs/heads/')) return 'conflict';
  return { side: 'a', update: { ref, to: b, from: a } };
}

/** HEAD as one comparable value: the branch it names, or the commit it is detached at. */
export function headValue(head: { ref: string | null; oid: string | null }): string | null {
  if (head.ref) return `ref:${head.ref}`;
  return head.oid ? `oid:${head.oid}` : null;
}

/**
 * Which side's HEAD has to follow the other. `base` is undefined when the sides never agreed;
 * then, and when both moved, `prefer` names the side whose HEAD stands.
 */
export function planHead(
  base: string | null | undefined,
  a: string | null,
  b: string | null,
  prefer: Side
): { side: Side; to: string } | null {
  if (a === b) return null;
  let follower: Side;
  if (base !== undefined && b === base) follower = 'b';
  else if (base !== undefined && a === base) follower = 'a';
  else follower = prefer === 'a' ? 'b' : 'a';
  const to = follower === 'a' ? b : a;
  return to === null ? null : { side: follower, to };
}

/** The refs a side holds once its updates are applied. */
export function applyRefUpdates(refs: RefMap, updates: readonly RefUpdate[]): RefMap {
  const next: RefMap = { ...refs };
  for (const update of updates) {
    if (update.to === null) delete next[update.ref];
    else next[update.ref] = update.to;
  }
  return next;
}

/** The next base: every ref both sides now agree on; a ref they differ on keeps its old one. */
export function agreedRefs(previous: RefMap | null, a: RefMap, b: RefMap): RefMap {
  const next: RefMap = {};
  for (const ref of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[ref] !== undefined && a[ref] === b[ref]) next[ref] = a[ref];
    else if (previous?.[ref] !== undefined) next[ref] = previous[ref];
  }
  return next;
}

const ZERO_OID = '0'.repeat(40);

/** The input of `git update-ref --stdin` for a set of conditional updates. */
export function updateRefInput(updates: readonly RefUpdate[]): string {
  return updates
    .map((update) =>
      update.to === null
        ? `delete ${update.ref} ${update.from ?? ''}`.trimEnd()
        : `update ${update.ref} ${update.to} ${update.from ?? ZERO_OID}`
    )
    .map((line) => `${line}\n`)
    .join('');
}
