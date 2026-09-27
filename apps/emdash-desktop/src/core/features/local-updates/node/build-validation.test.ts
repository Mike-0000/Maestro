import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertSqliteBinding,
  deliveryBootstrapCommands,
  hashTree,
  REQUIRED_BUILD_CHECKS,
  VALIDATION_COMMANDS,
} from './coordinator/build-validation.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('requires static checks, Chorus delivery tests, and the Electron-ABI rebuild', () => {
  expect(VALIDATION_COMMANDS.map(([name]) => name)).toEqual(REQUIRED_BUILD_CHECKS);
  expect(REQUIRED_BUILD_CHECKS).toEqual([
    'frozen-install',
    'workspace-build',
    'node-test-deps',
    'workspace-static-check',
    'chorus-delivery-tests',
    'electron-native-rebuild',
    'windows-package',
  ]);
  const staticCheck = VALIDATION_COMMANDS.find(([name]) => name === 'workspace-static-check')?.[1];
  expect(staticCheck).toContain('pnpm run format:check');
  expect(staticCheck).toContain('pnpm run lint');
  expect(staticCheck).toContain('pnpm run typecheck');
  const deliveryTests = VALIDATION_COMMANDS.find(([name]) => name === 'chorus-delivery-tests')?.[1];
  expect(deliveryTests).toContain('src/core/features/local-updates/node');
  expect(deliveryTests).toContain(
    'src/core/features/conductor/browser/hud/local-update-flow.test.ts'
  );
  expect(deliveryTests).toContain('src/api/connection-robustness.test.ts');
  expect(VALIDATION_COMMANDS.every(([, command]) => !command.includes('pnpm run check'))).toBe(
    true
  );
});

it('runs the same focused checks through older installed Windows coordinators', () => {
  const environment = {
    CI: 'true',
    CHORUS_DELIVERY_BUILD_OUTPUT: 'C:\\scratch\\artifacts',
    CHORUS_BUILD_PROVENANCE_JSON: JSON.stringify({
      deliveryProtocol: 1,
      candidateId: 'candidate',
      commit: 'commit',
    }),
  };
  expect(deliveryBootstrapCommands(environment, 'win32')?.map(([name]) => name)).toEqual([
    'node-test-deps',
    'workspace-static-check',
    'chorus-delivery-tests',
  ]);
  expect(deliveryBootstrapCommands(environment, 'linux')).toBeNull();
  expect(deliveryBootstrapCommands({ ...environment, CI: 'false' }, 'win32')).toBeNull();
  expect(
    deliveryBootstrapCommands({ ...environment, CHORUS_BUILD_PROVENANCE_JSON: '{}' }, 'win32')
  ).toBeNull();
  expect(deliveryBootstrapCommands({}, 'win32')).toBeNull();
});

it('hashes the physical app.asar bytes as a package file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chorus-package-hash-'));
  roots.push(root);
  const bytes = Buffer.from('physical asar bytes');
  await writeFile(join(root, 'app.asar'), bytes);
  expect(await hashTree(root)).toEqual([
    { path: 'app.asar', sha256: createHash('sha256').update(bytes).digest('hex') },
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
