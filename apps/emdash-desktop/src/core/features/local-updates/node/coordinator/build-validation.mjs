import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
export const VALIDATION_COMMANDS = [
  ['frozen-install', 'corepack pnpm install --frozen-lockfile --ignore-scripts'],
  ['workspace-build', 'corepack pnpm run build'],
  // The frozen install skips the app postinstall that provisions the separate system-Node
  // better-sqlite3 copy used by Vitest. CI installs it explicitly before the test target.
  [
    'node-test-deps',
    'corepack pnpm --dir apps/emdash-desktop/tooling/node-deps install --frozen-lockfile && corepack pnpm --dir apps/emdash-desktop/tooling/node-deps rebuild better-sqlite3 && corepack pnpm --filter @emdash/core rebuild node-pty',
  ],
  // Keep static checks for the whole tree without making a Windows install depend on
  // unrelated Linux-only or inherited Emdash tests.
  [
    'workspace-static-check',
    'corepack pnpm run format:check && corepack pnpm run lint && corepack pnpm run typecheck',
  ],
  [
    'chorus-delivery-tests',
    'corepack pnpm --dir apps/emdash-desktop exec vitest run --project node src/core/features/local-updates/node src/core/features/conductor/browser/hud/local-update-flow.test.ts && corepack pnpm --dir packages/wire exec vitest run src/api/connection-robustness.test.ts',
  ],
  // The frozen install deliberately skips lifecycle scripts, including the app's Electron-ABI
  // rebuild. electron-builder has npmRebuild: false, so build the addon explicitly before packing.
  ['electron-native-rebuild', 'corepack pnpm exec electron-rebuild -f --only=better-sqlite3'],
  [
    'windows-package',
    'corepack pnpm exec electron-builder --win --dir --publish never --config electron-builder.config.ts',
  ],
];
export const REQUIRED_BUILD_CHECKS = VALIDATION_COMMANDS.map(([name]) => name);

export async function validateIntegratedCandidate({ repositoryPath, candidate, stateRoot, git }) {
  if (process.platform !== 'win32') {
    throw new Error('Local Chorus installation builds currently require Windows.');
  }
  const buildId = randomUUID();
  const buildRoot = resolve(stateRoot, 'BuildWorktrees', candidate.id);
  const artifactRoot = resolve(stateRoot, 'Artifacts', candidate.id);
  const logRoot = resolve(stateRoot, 'Logs', candidate.id);
  const statePrefix = `${resolve(stateRoot)}${process.platform === 'win32' ? '\\' : '/'}`;
  for (const path of [buildRoot, artifactRoot, logRoot]) {
    if (!path.toLocaleLowerCase().startsWith(statePrefix.toLocaleLowerCase())) {
      throw new Error('Build path escaped the delivery state directory.');
    }
  }
  for (const [path, label] of [
    [buildRoot, 'build worktree'],
    [artifactRoot, 'build artifacts'],
  ]) {
    await access(path).then(
      () => {
        throw new Error(`A previous ${label} already exists for this candidate.`);
      },
      () => undefined
    );
  }
  await mkdir(dirname(buildRoot), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(logRoot, { recursive: true });
  await git(repositoryPath, ['worktree', 'add', '--detach', buildRoot, candidate.commit]);
  let mounted = true;
  try {
    const appMetadata = JSON.parse(
      await readFile(join(buildRoot, 'apps', 'emdash-desktop', 'package.json'), 'utf8')
    );
    const provenance = {
      deliveryProtocol: 1,
      buildId,
      version: appMetadata.version,
      candidateId: candidate.id,
      repositoryId: candidate.repositoryId,
      commit: candidate.commit,
      base: candidate.base,
      included: candidate.included,
      generation: candidate.generation,
    };
    const environment = {
      ...process.env,
      CI: 'true',
      TELEMETRY_ENABLED: 'false',
      EMDASH_DISABLE_PTY: 'true',
      CHORUS_DELIVERY_BUILD_OUTPUT: artifactRoot,
      CHORUS_BUILD_PROVENANCE_JSON: JSON.stringify(provenance),
    };
    // Tools that shell out to a bare `pnpm` (Nx targets, electron-builder's module collector) can
    // resolve a global npm `pnpm.cmd` that launches the quoted `node` from node_modules/.bin, where
    // cmd.exe expands %~dp0 wrongly ("The system cannot find the path specified"). Route them
    // through corepack, whose shim launches the node.exe next to it by absolute path.
    const toolchainRoot = resolve(stateRoot, 'Toolchain');
    await mkdir(toolchainRoot, { recursive: true });
    await writeFile(join(toolchainRoot, 'pnpm.cmd'), '@corepack pnpm %*\r\n', 'utf8');
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    environment[pathKey] = `${toolchainRoot};${environment[pathKey] ?? ''}`;
    const checks = [];
    for (const [name, command] of VALIDATION_COMMANDS) {
      const workingDirectory =
        name === 'windows-package' || name === 'electron-native-rebuild'
          ? join(buildRoot, 'apps', 'emdash-desktop')
          : buildRoot;
      const output = await runFixedCommand(
        command,
        workingDirectory,
        environment,
        join(logRoot, `${name}.log`)
      );
      if (name === 'frozen-install') {
        const pnpmVersion = await runFixedCommand(
          'corepack pnpm --version',
          buildRoot,
          environment,
          join(logRoot, 'pnpm-version.log')
        );
        provenance.pnpmVersion = pnpmVersion.trim().split(/\r?\n/).at(-1) ?? '';
      }
      if (name === 'node-test-deps') {
        await assertSqliteBinding(
          join(
            buildRoot,
            'apps',
            'emdash-desktop',
            'tooling',
            'node-deps',
            'node_modules',
            'better-sqlite3'
          )
        );
        await runFixedCommand(
          "corepack pnpm exec node -e \"require('better-sqlite3')(':memory:').close()\"",
          join(buildRoot, 'apps', 'emdash-desktop', 'tooling', 'node-deps'),
          environment,
          join(logRoot, 'node-test-deps-load.log')
        );
      }
      if (name === 'electron-native-rebuild') {
        await assertSqliteBinding(join(buildRoot, 'node_modules', 'better-sqlite3'));
      }
      checks.push({ name, success: true, output: output.slice(-4000) });
    }
    const executablePath = join(artifactRoot, 'win-unpacked', 'Chorus.exe');
    await access(executablePath);
    await assertSqliteBinding(
      join(
        artifactRoot,
        'win-unpacked',
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3'
      )
    );
    const hashes = await hashTree(join(artifactRoot, 'win-unpacked'));
    const artifactDigest = createHash('sha256')
      .update(hashes.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(''))
      .digest('hex');
    const manifest = {
      ...provenance,
      toolchain: { node: process.versions.node, pnpm: provenance.pnpmVersion },
      architecture: process.arch,
      platform: process.platform,
      checks: REQUIRED_BUILD_CHECKS,
      artifactRoot: join(artifactRoot, 'win-unpacked'),
      artifactDigest,
      files: hashes,
      createdAt: new Date().toISOString(),
    };
    const manifestPath = join(artifactRoot, 'build-manifest.json');
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await rename(temporaryManifest, manifestPath);
    return {
      integratedCommit: candidate.commit,
      checks: REQUIRED_BUILD_CHECKS,
      buildId,
      artifactRoot: manifest.artifactRoot,
      artifactDigest,
      manifestPath,
      toolchain: manifest.toolchain,
      checkedAt: manifest.createdAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(join(logRoot, 'failure.txt'), message, 'utf8').catch(() => undefined);
    throw new Error(`Candidate build ${buildId} failed: ${message}`);
  } finally {
    if (mounted) {
      try {
        await git(repositoryPath, ['worktree', 'remove', '--force', buildRoot]);
        mounted = false;
      } catch {
        // Keep the failed build worktree registered so an operator can inspect and remove it.
      }
    }
  }
}

export async function assertSqliteBinding(moduleRoot) {
  const binding = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
  const file = await stat(binding).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`Windows package is missing the better-sqlite3 native binding: ${binding}`);
  }
}

async function runFixedCommand(command, cwd, env, logPath) {
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFile('cmd.exe', ['/d', '/s', '/c', command], {
      cwd,
      env,
      windowsHide: true,
      timeout: 3 * 60 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    await writeFile(logPath, `${stdout}\n${stderr}`, 'utf8');
    throw new Error(`${command} failed (${error.code ?? 'unknown'}). See ${logPath}.`);
  }
  await writeFile(logPath, `${stdout}\n${stderr}`, 'utf8');
  return stdout;
}

async function hashTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Packaged artifact contains a link: ${path}`);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const sha256 = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256 });
      } else {
        throw new Error(`Packaged artifact contains a special file: ${path}`);
      }
    }
  }
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) throw new Error('Windows package contains no files.');
  return files;
}
