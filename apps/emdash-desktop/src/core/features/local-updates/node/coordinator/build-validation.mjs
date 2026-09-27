import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
export const REQUIRED_BUILD_CHECKS = [
  'frozen-install',
  'workspace-build',
  'workspace-check',
  'windows-package',
];

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
    const checks = [];
    const commands = [
      ['frozen-install', 'corepack pnpm install --frozen-lockfile --ignore-scripts'],
      ['workspace-build', 'corepack pnpm run build'],
      ['workspace-check', 'corepack pnpm run check'],
      [
        'windows-package',
        'corepack pnpm exec electron-builder --win --dir --publish never --config electron-builder.config.ts',
      ],
    ];
    for (const [name, command] of commands) {
      const workingDirectory =
        name === 'windows-package' ? join(buildRoot, 'apps', 'emdash-desktop') : buildRoot;
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
      checks.push({ name, success: true, output: output.slice(-4000) });
    }
    const executablePath = join(artifactRoot, 'win-unpacked', 'Chorus.exe');
    await access(executablePath);
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
