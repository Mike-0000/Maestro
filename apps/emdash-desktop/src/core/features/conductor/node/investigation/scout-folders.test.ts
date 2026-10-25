import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkScoutFolder,
  isNetworkFolder,
  MAX_SCOUT_FOLDERS,
  usableScoutFolders,
  withoutExtendedPrefix,
} from './scout-folders';

let root: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scout-folders-'));
  home = path.join(root, 'home');
  for (const folder of [
    'home/notes',
    'home/work/project',
    'home/work/project/docs',
    'home/.config/gh',
    'home/AppData/Roaming',
    'home/keys.pem',
    'home/data (old)',
  ]) {
    await mkdir(path.join(root, folder), { recursive: true });
  }
  await symlink(path.join(home, '.config'), path.join(home, 'settings-link'), 'junction');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const check = (folder: string) => checkScoutFolder(folder, { home });

describe('checkScoutFolder', () => {
  it('accepts a named folder of work and returns its real path', async () => {
    expect(await check(path.join(home, 'notes'))).toEqual({
      ok: true,
      path: path.join(await import('node:fs/promises').then((fs) => fs.realpath(home)), 'notes'),
    });
  });

  it('refuses a drive, the home folder, and anything holding the home folder', async () => {
    expect(await check(path.parse(root).root)).toMatchObject({ ok: false });
    expect(await check(home)).toEqual({
      ok: false,
      reason: 'The whole home folder cannot be read.',
    });
    expect(await check(root)).toEqual({
      ok: false,
      reason: 'That folder holds the home folder, so it cannot be read.',
    });
  });

  it('refuses hidden, settings and secret folders, also behind a link', async () => {
    for (const folder of ['.config/gh', 'AppData/Roaming', 'keys.pem', 'settings-link']) {
      expect(await check(path.join(home, folder))).toMatchObject({ ok: false });
    }
  });

  it('refuses relative, missing and pattern-like paths', async () => {
    expect(await check('notes')).toEqual({
      ok: false,
      reason: 'Give the full path of the folder.',
    });
    expect(await check(path.join(home, 'missing'))).toEqual({
      ok: false,
      reason: 'That folder does not exist.',
    });
    expect(await check(path.join(home, 'data (old)'))).toMatchObject({ ok: false });
    expect(await check('   ')).toEqual({ ok: false, reason: 'No folder was given.' });
  });

  it('refuses a network folder on Windows', async () => {
    expect(await checkScoutFolder('\\\\server\\share', { home, platform: 'win32' })).toEqual({
      ok: false,
      reason: 'Network folders are not supported.',
    });
  });
});

describe('isNetworkFolder', () => {
  const SHARES = [
    '\\\\10.0.0.5\\c\\Program Files (x86)\\Steam',
    '//10.0.0.5/c/Program Files (x86)/Steam',
    '\\\\?\\UNC\\10.0.0.5\\c\\Games',
    '\\\\?\\unc\\10.0.0.5\\c\\Games',
    '\\\\.\\C:\\Games',
    '\\\\.\\PhysicalDrive0',
    '\\\\?\\Volume{0a1b2c3d-0000-0000-0000-100000000000}\\Games',
    '//?/C:/Games',
    '  \\\\server\\share',
  ];

  it('catches every network form on Windows', () => {
    for (const folder of SHARES) expect(isNetworkFolder(folder, 'win32'), folder).toBe(true);
  });

  it('lets local folders through, and leaves other systems alone', () => {
    for (const folder of [
      'C:\\Github\\chorus',
      'D:/games',
      '\\Users\\dev',
      '\\\\?\\C:\\Github\\chorus',
      '\\\\?\\d:\\games',
    ]) {
      expect(isNetworkFolder(folder, 'win32'), folder).toBe(false);
    }
    expect(isNetworkFolder('//srv/app', 'linux')).toBe(false);
  });

  it('reads a local drive path in extended form as the plain path', () => {
    expect(withoutExtendedPrefix('\\\\?\\C:\\Github\\chorus', 'win32')).toBe('C:\\Github\\chorus');
    for (const folder of ['\\\\?\\UNC\\server\\share', '\\\\.\\C:\\Games', 'C:\\Games']) {
      expect(withoutExtendedPrefix(folder, 'win32'), folder).toBe(folder);
    }
    expect(withoutExtendedPrefix('\\\\?\\C:\\Games', 'linux')).toBe('\\\\?\\C:\\Games');
  });
});

describe('usableScoutFolders', () => {
  it('keeps checked folders once, drops ones inside the project, and reports refusals', async () => {
    const project = path.join(home, 'work', 'project');
    const notes = path.join(home, 'notes');
    const result = await usableScoutFolders(
      [notes, notes, path.join(project, 'docs'), home, path.join(home, 'work')],
      project,
      { home }
    );
    expect(result.folders.map((folder) => path.basename(folder))).toEqual(['notes', 'work']);
    expect(result.refused).toEqual([
      { folder: home, reason: 'The whole home folder cannot be read.' },
    ]);
  });

  it(`passes at most ${MAX_SCOUT_FOLDERS} folders`, async () => {
    const many: string[] = [];
    for (let index = 0; index <= MAX_SCOUT_FOLDERS; index += 1) {
      const folder = path.join(root, 'many', `f${index}`);
      await mkdir(folder, { recursive: true });
      many.push(folder);
    }
    const result = await usableScoutFolders(many, path.join(home, 'work', 'project'), { home });
    expect(result.folders).toHaveLength(MAX_SCOUT_FOLDERS);
    expect(result.refused).toHaveLength(1);
  });
});
