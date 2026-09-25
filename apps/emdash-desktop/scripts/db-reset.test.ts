import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDbResetTargets } from './db-reset.ts';

function expectTargetsToContain(targets: string[], expected: string): void {
  expect(targets.map((target) => path.normalize(target))).toContain(path.normalize(expected));
}

describe('resolveDbResetTargets', () => {
  it('targets the EMDASH_DB_FILE family when the override is set', () => {
    const targets = resolveDbResetTargets({
      dbFile: '/tmp/scratch.db',
      platform: 'darwin',
      home: '/Users/dev',
    });

    expectTargetsToContain(targets, '/tmp/scratch.db');
    expectTargetsToContain(targets, '/tmp/scratch-file-search.db');
    expectTargetsToContain(targets, '/tmp/scratch-automations.db');
    expectTargetsToContain(targets, '/tmp/scratch-operations.db');
    // Every database file brings its SQLite sidecars along.
    expectTargetsToContain(targets, '/tmp/scratch.db-wal');
    expectTargetsToContain(targets, '/tmp/scratch.db-shm');
    expectTargetsToContain(targets, '/tmp/scratch-file-search.db-wal');
    // The default dev databases are left alone when the override is set.
    expect(targets.some((target) => target.includes('chorus-dev'))).toBe(false);
  });

  it('derives sibling names for override paths without a .db extension', () => {
    const targets = resolveDbResetTargets({
      dbFile: '/tmp/scratch',
      platform: 'linux',
      home: '/home/dev',
    });

    expectTargetsToContain(targets, '/tmp/scratch');
    expectTargetsToContain(targets, '/tmp/scratch-file-search.db');
  });

  it('targets the default dev databases in the macOS userData dir', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'darwin',
      home: '/Users/dev',
    });

    const dir = '/Users/dev/Library/Application Support/chorus-dev';
    expectTargetsToContain(targets, `${dir}/emdash4.db`);
    expectTargetsToContain(targets, `${dir}/emdash4-file-search.db`);
    expectTargetsToContain(targets, `${dir}/emdash4-automations.db`);
    expectTargetsToContain(targets, `${dir}/emdash4-operations.db`);
    expectTargetsToContain(targets, `${dir}/emdash3.db`);
    expectTargetsToContain(targets, `${dir}/emdash4.db-wal`);
    expectTargetsToContain(targets, `${dir}/emdash4.db-shm`);
  });

  it('targets the default dev databases in the Linux config dir', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'linux',
      home: '/home/dev',
    });

    expectTargetsToContain(targets, '/home/dev/.config/chorus-dev/emdash4.db');
  });

  it('targets the default dev databases under APPDATA on Windows', () => {
    const targets = resolveDbResetTargets({
      dbFile: undefined,
      platform: 'win32',
      home: 'C:\\Users\\dev',
      appData: 'C:\\Users\\dev\\AppData\\Roaming',
    });

    expect(
      targets.some((target) => target.includes('chorus-dev') && target.endsWith('emdash4.db'))
    ).toBe(true);
  });
});
