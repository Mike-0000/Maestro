import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertSqliteBinding, REQUIRED_BUILD_CHECKS } from './coordinator/build-validation.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('requires the Electron-ABI rebuild before accepting a Windows package', () => {
  expect(REQUIRED_BUILD_CHECKS).toEqual([
    'frozen-install',
    'workspace-build',
    'workspace-check',
    'electron-native-rebuild',
    'windows-package',
  ]);
});

it('rejects packages without a nonempty better-sqlite3 binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chorus-sqlite-package-'));
  roots.push(root);
  const moduleRoot = join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
  const releaseDir = join(moduleRoot, 'build', 'Release');
  const binding = join(releaseDir, 'better_sqlite3.node');
  await expect(assertSqliteBinding(moduleRoot)).rejects.toThrow('missing the better-sqlite3');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(binding, '');
  await expect(assertSqliteBinding(moduleRoot)).rejects.toThrow('missing the better-sqlite3');
  await writeFile(binding, 'native addon bytes');
  await expect(assertSqliteBinding(moduleRoot)).resolves.toBeUndefined();
});
