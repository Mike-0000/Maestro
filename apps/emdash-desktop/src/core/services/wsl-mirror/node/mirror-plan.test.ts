import { describe, expect, it } from 'vitest';
import {
  applyRescan,
  planMirror,
  resolveCompare,
  type Base,
  type Snapshot,
  type SnapshotEntry,
} from './mirror-plan';
import {
  agreedRefs,
  applyRefUpdates,
  headValue,
  planHead,
  planRefs,
  settleRef,
  updateRefInput,
} from './mirror-refs';

const file = (size: number, mtimeMs: number): SnapshotEntry => ({ kind: 'f', size, mtimeMs });
const dir: SnapshotEntry = { kind: 'd', size: 0, mtimeMs: 0 };
const snap = (entries: Record<string, SnapshotEntry>): Snapshot => new Map(Object.entries(entries));
const stat = (size: number, mtimeMs: number) => ({ size, mtimeMs });

describe('planMirror', () => {
  const base: Base = new Map([['f.txt', { kind: 'f', a: stat(1, 10), b: stat(1, 20) }]]);

  it('does nothing when neither side moved', () => {
    const plan = planMirror(
      base,
      snap({ 'f.txt': file(1, 10) }),
      snap({ 'f.txt': file(1, 20) }),
      'normal'
    );
    expect(plan.copies).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(plan.compares).toEqual([]);
  });

  it('carries a change from the side that made it', () => {
    const plan = planMirror(
      base,
      snap({ 'f.txt': file(1, 10) }),
      snap({ 'f.txt': file(5, 99) }),
      'normal'
    );
    expect(plan.copies).toEqual([
      {
        path: 'f.txt',
        from: 'b',
        source: stat(5, 99),
        expect: stat(1, 10),
        backup: false,
        conflict: false,
      },
    ]);
  });

  it('deletes only what is unchanged since both sides agreed', () => {
    const untouched = planMirror(base, snap({ 'f.txt': file(1, 10) }), snap({}), 'normal');
    expect(untouched.deletes).toEqual([
      { path: 'f.txt', side: 'a', expect: stat(1, 10), keep: false },
    ]);

    // Edited here, deleted there: the edit wins and the file comes back.
    const edited = planMirror(base, snap({ 'f.txt': file(7, 50) }), snap({}), 'normal');
    expect(edited.deletes).toEqual([]);
    expect(edited.copies).toMatchObject([{ path: 'f.txt', from: 'a', expect: null }]);
  });

  it('treats a file with no base as new, never as deleted', () => {
    const plan = planMirror(new Map(), snap({}), snap({ 'new.txt': file(3, 5) }), 'normal');
    expect(plan.deletes).toEqual([]);
    expect(plan.copies).toMatchObject([{ path: 'new.txt', from: 'b', expect: null }]);
  });

  it('settles a file changed on both sides by keeping the newer and backing up the other', () => {
    const plan = planMirror(
      base,
      snap({ 'f.txt': file(4, 100) }),
      snap({ 'f.txt': file(9, 200) }),
      'normal'
    );
    expect(plan.copies).toEqual([
      {
        path: 'f.txt',
        from: 'b',
        source: stat(9, 200),
        expect: stat(4, 100),
        backup: true,
        conflict: true,
      },
    ]);
  });

  it('compares contents when both changed to the same size', () => {
    const plan = planMirror(
      base,
      snap({ 'f.txt': file(4, 100) }),
      snap({ 'f.txt': file(4, 200) }),
      'normal'
    );
    expect(plan.copies).toEqual([]);
    const [compare] = plan.compares;
    expect(compare).toEqual({ path: 'f.txt', a: stat(4, 100), b: stat(4, 200) });
    if (!compare) return;
    expect(resolveCompare(compare, 'x', 'x', 'normal')).toBe('agreed');
    expect(resolveCompare(compare, null, 'x', 'normal')).toBe('unreadable');
    expect(resolveCompare(compare, 'x', 'y', 'normal')).toMatchObject({ from: 'b', backup: true });
  });

  it('makes the copy match side a on a first run', () => {
    const plan = planMirror(
      new Map(),
      snap({ 'same.txt': file(2, 1), 'differs.txt': file(3, 1), 'only-a.txt': file(1, 1) }),
      snap({ 'same.txt': file(2, 9), 'differs.txt': file(8, 9), 'only-b.txt': file(1, 9) }),
      'seed'
    );
    expect(plan.compares.map((compare) => compare.path)).toEqual(['same.txt']);
    expect(plan.copies.map((op) => [op.path, op.from, op.backup])).toEqual([
      ['differs.txt', 'a', true],
      ['only-a.txt', 'a', false],
    ]);
    // Moved aside, never destroyed: nothing says the file exists anywhere else.
    expect(plan.deletes).toEqual([
      { path: 'only-b.txt', side: 'b', expect: stat(1, 9), keep: true },
    ]);
  });

  it('plans each path in its own mode', () => {
    // After a first run only the paths it left open still take side a for the truth.
    const plan = planMirror(
      new Map(),
      snap({}),
      snap({ 'left-open.txt': file(1, 9), 'made-since.txt': file(1, 9) }),
      (path) => (path === 'left-open.txt' ? 'seed' : 'normal')
    );
    expect(plan.deletes.map((op) => op.path)).toEqual(['left-open.txt']);
    expect(plan.copies.map((op) => [op.path, op.from])).toEqual([['made-since.txt', 'b']]);
  });

  it('never deletes when the base was lost', () => {
    const plan = planMirror(
      new Map(),
      snap({ 'only-a.txt': file(1, 1), dirA: dir }),
      snap({ 'only-b.txt': file(1, 9) }),
      'merge'
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.rmdirs).toEqual([]);
    expect(plan.copies.map((op) => [op.path, op.from])).toEqual([
      ['only-a.txt', 'a'],
      ['only-b.txt', 'b'],
    ]);
    expect(plan.mkdirs).toEqual([{ path: 'dirA', side: 'b' }]);
  });

  it('removes folders deepest first, and only ones both sides had', () => {
    const dirs: Base = new Map([
      ['x', { kind: 'd' }],
      ['x/y', { kind: 'd' }],
    ]);
    const plan = planMirror(dirs, snap({}), snap({ x: dir, 'x/y': dir, fresh: dir }), 'normal');
    expect(plan.rmdirs).toEqual([
      { path: 'x/y', side: 'b' },
      { path: 'x', side: 'b' },
    ]);
    expect(plan.mkdirs).toEqual([{ path: 'fresh', side: 'a' }]);
  });

  it('drops base entries for paths gone from both sides', () => {
    expect(planMirror(base, snap({}), snap({}), 'normal').drops).toEqual(['f.txt']);
  });
});

describe('applyRescan', () => {
  it('removes a path with everything under it, then adds what is there now', () => {
    const snapshot = snap({ a: dir, 'a/x.txt': file(1, 1), 'a-b.txt': file(1, 1) });
    applyRescan(snapshot, ['a'], [['c.txt', 'f', 2, 3]]);
    expect([...snapshot.keys()].sort()).toEqual(['a-b.txt', 'c.txt']);
  });
});

describe('planRefs', () => {
  const X = 'x'.repeat(40);
  const Y = 'y'.repeat(40);
  const Z = 'z'.repeat(40);

  it('moves the side that did not change the ref', () => {
    const plan = planRefs(
      { 'refs/heads/main': X },
      { 'refs/heads/main': Y },
      { 'refs/heads/main': X }
    );
    expect(plan.setB).toEqual([{ ref: 'refs/heads/main', to: Y, from: X }]);
    expect(plan.setA).toEqual([]);
  });

  it('carries a deletion, but keeps a ref that was deleted on one side and moved on the other', () => {
    const base = { 'refs/heads/gone': X, 'refs/heads/moved': X };
    const plan = planRefs(base, { 'refs/heads/moved': Y }, { 'refs/heads/gone': X });
    expect(plan.setB).toEqual([
      { ref: 'refs/heads/gone', to: null, from: X },
      { ref: 'refs/heads/moved', to: Y, from: null },
    ]);
  });

  it('contests a ref both sides moved', () => {
    const plan = planRefs(
      { 'refs/heads/main': X },
      { 'refs/heads/main': Y },
      { 'refs/heads/main': Z }
    );
    expect(plan.contested).toEqual([{ ref: 'refs/heads/main', a: Y, b: Z }]);
    const [contested] = plan.contested;
    if (!contested) return;
    expect(settleRef(contested, 'a-behind')).toEqual({
      side: 'a',
      update: { ref: 'refs/heads/main', to: Z, from: Y },
    });
    expect(settleRef(contested, 'diverged')).toBe('conflict');
    expect(settleRef({ ...contested, ref: 'refs/tags/v1' }, 'diverged')).toMatchObject({
      side: 'a',
    });
  });

  it('takes side a on a first run and drops the clone’s stand-in remote refs', () => {
    const plan = planRefs(
      null,
      { 'refs/heads/main': X, 'refs/heads/side': Y },
      { 'refs/heads/main': Z, 'refs/remotes/origin/main': X, 'refs/heads/own': Z },
      true
    );
    // A branch that differs may hold work on either side, so it is not simply overwritten.
    expect(plan.contested).toEqual([{ ref: 'refs/heads/main', a: X, b: Z }]);
    expect(plan.setB).toEqual([
      { ref: 'refs/heads/side', to: Y, from: null },
      { ref: 'refs/remotes/origin/main', to: null, from: X },
    ]);
    expect(plan.setA).toEqual([{ ref: 'refs/heads/own', to: Z, from: null }]);
  });

  it('writes conditional updates for git', () => {
    expect(
      updateRefInput([
        { ref: 'refs/heads/a', to: X, from: null },
        { ref: 'refs/heads/b', to: Y, from: X },
        { ref: 'refs/heads/c', to: null, from: Z },
      ])
    ).toBe(
      `update refs/heads/a ${X} ${'0'.repeat(40)}\nupdate refs/heads/b ${Y} ${X}\ndelete refs/heads/c ${Z}\n`
    );
  });

  it('keeps the old base for refs the sides still differ on', () => {
    const a = applyRefUpdates({ m: X, d: Y }, [{ ref: 'n', to: Z, from: null }]);
    expect(agreedRefs({ d: X }, a, { m: X, d: Z, n: Z })).toEqual({ m: X, d: X, n: Z });
  });
});

describe('planHead', () => {
  it('follows the side that moved, and prefers one when both did', () => {
    expect(planHead('ref:refs/heads/main', 'ref:refs/heads/x', 'ref:refs/heads/main', 'b')).toEqual(
      {
        side: 'b',
        to: 'ref:refs/heads/x',
      }
    );
    expect(planHead('ref:refs/heads/main', 'ref:refs/heads/x', 'ref:refs/heads/y', 'b')).toEqual({
      side: 'a',
      to: 'ref:refs/heads/y',
    });
    expect(planHead(undefined, 'ref:refs/heads/x', 'ref:refs/heads/y', 'a')).toEqual({
      side: 'b',
      to: 'ref:refs/heads/x',
    });
    expect(planHead(undefined, 'ref:refs/heads/x', 'ref:refs/heads/x', 'a')).toBeNull();
    expect(headValue({ ref: null, oid: 'abc' })).toBe('oid:abc');
    expect(headValue({ ref: null, oid: null })).toBeNull();
  });
});
