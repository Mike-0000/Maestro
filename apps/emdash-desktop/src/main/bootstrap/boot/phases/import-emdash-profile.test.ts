import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importEmdashProfileOnce, PROFILE_IMPORT_MARKER } from './import-emdash-profile';

let root: string;
let source: string;
let target: string;
const now = new Date('2026-09-25T12:00:00.000Z');

function write(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chorus-profile-import-'));
  source = join(root, 'emdash');
  target = join(root, 'chorus');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('importEmdashProfileOnce', () => {
  it('copies the Emdash profile into an empty Chorus profile and leaves the source intact', () => {
    write(join(source, 'emdash4.db'), 'projects');
    write(join(source, 'emdash4.db-wal'), 'wal');
    write(join(source, 'Local State'), 'os_crypt key');
    write(join(source, 'Cache', 'data'), 'cache');

    expect(importEmdashProfileOnce({ sourcePath: source, targetPath: target, now })).toEqual({
      kind: 'imported',
      backupPath: null,
    });

    expect(readFileSync(join(target, 'emdash4.db'), 'utf8')).toBe('projects');
    expect(readFileSync(join(target, 'emdash4.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(target, 'Local State'), 'utf8')).toBe('os_crypt key');
    expect(existsSync(join(target, 'Cache'))).toBe(false);
    expect(readFileSync(join(source, 'emdash4.db'), 'utf8')).toBe('projects');
  });

  it('backs up an existing Chorus profile and drops its stale database sidecars', () => {
    write(join(source, 'emdash4.db'), 'old projects');
    write(join(target, 'emdash4.db'), 'fresh');
    write(join(target, 'emdash4.db-shm'), 'stale shm');
    write(join(target, 'logs', 'emdash.log'), 'open log');

    const result = importEmdashProfileOnce({ sourcePath: source, targetPath: target, now });

    expect(result.kind).toBe('imported');
    const backupPath = result.kind === 'imported' ? result.backupPath : null;
    expect(backupPath).not.toBeNull();
    expect(readFileSync(join(backupPath!, 'emdash4.db'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(backupPath!, 'emdash4.db-shm'), 'utf8')).toBe('stale shm');
    expect(readFileSync(join(target, 'emdash4.db'), 'utf8')).toBe('old projects');
    expect(existsSync(join(target, 'emdash4.db-shm'))).toBe(false);
    expect(readFileSync(join(target, 'logs', 'emdash.log'), 'utf8')).toBe('open log');
  });

  it('runs only once, so later launches and upgrades never replace Chorus data', () => {
    write(join(source, 'emdash4.db'), 'old projects');
    importEmdashProfileOnce({ sourcePath: source, targetPath: target, now });
    write(join(target, 'emdash4.db'), 'new chorus work');

    expect(importEmdashProfileOnce({ sourcePath: source, targetPath: target, now })).toEqual({
      kind: 'already-imported',
    });
    expect(readFileSync(join(target, 'emdash4.db'), 'utf8')).toBe('new chorus work');
  });

  it('marks a machine without an Emdash profile so a later Emdash install is never imported', () => {
    write(join(target, 'emdash4.db'), 'chorus work');

    expect(importEmdashProfileOnce({ sourcePath: source, targetPath: target, now }).kind).toBe(
      'nothing-to-import'
    );
    write(join(source, 'emdash4.db'), 'emdash');

    expect(importEmdashProfileOnce({ sourcePath: source, targetPath: target, now }).kind).toBe(
      'already-imported'
    );
    expect(readFileSync(join(target, 'emdash4.db'), 'utf8')).toBe('chorus work');
    expect(JSON.parse(readFileSync(join(target, PROFILE_IMPORT_MARKER), 'utf8'))).toMatchObject({
      importedFrom: null,
    });
  });

  it('removes a stale lockfile left by a crashed instance', () => {
    write(join(source, 'emdash4.db'), 'projects');
    write(join(source, 'lockfile'), '');

    expect(importEmdashProfileOnce({ sourcePath: source, targetPath: target, now }).kind).toBe(
      'imported'
    );
    expect(existsSync(join(target, 'lockfile'))).toBe(false);
  });
});
