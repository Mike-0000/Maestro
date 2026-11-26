// The Linux leg of a Maestro release, run on the Windows publishing machine after `/push`.
//
// It builds the x64 AppImage of the release `/push` just published (same commit, same version
// string, so a client-mode Windows app and its Linux host pass the build check), then signs and
// publishes it as `<channel>-linux.yml` with the same key and the same Azure feed. The build runs
// in Docker by default (a Debian 12 userspace, so the AppImage runs on Ubuntu 22.04 and later), or
// in a WSL distro with `--builder wsl`. Dry run by default: pass --publish to upload.
//
//   node --experimental-strip-types scripts/release/maestro-linux-release.ts            # build, dry-run publish
//   node --experimental-strip-types scripts/release/maestro-linux-release.ts --publish  # build and publish
//   ... --check                     only check Docker or WSL and print what would run
//   ... --version <v> --commit <sha> a release other than the last one /push published
//
// Run from apps/emdash-desktop. See docs/chorus/remote-rig.md and docs/chorus/auto-update.md.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  UPDATE_CHANNEL,
  UPDATE_FEED_URL,
} from '../../src/core/primitives/app-identity/api/app-identity.ts';
import { getBlobText } from './lib/azure-blob.ts';
import { exec, execOrNull } from './lib/exec.ts';
import { fail, info, step, warn } from './lib/log.ts';
import {
  DEFAULT_LINUX_BUILD_IMAGE,
  dockerBuildArgs,
  feedStorageTarget,
  LINUX_BUILD_SCRIPT,
  parseLastRelease,
  remoteLogsBuildEnv,
  toWslPath,
  wslEnv,
  type ReleaseRef,
} from './lib/maestro-linux-release.ts';
import {
  feedBlobUrl,
  isMaestroReleaseVersion,
  linuxUpdateBuildsRoot,
  manifestFileName,
  parseManifest,
  updateBuildsRoot,
  UPLOAD_SAS_ENV,
} from './lib/maestro-update.ts';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--'),
  options: {
    version: { type: 'string' },
    commit: { type: 'string' },
    publish: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    builder: { type: 'string', default: 'docker' },
    distro: { type: 'string' },
    image: { type: 'string' },
    notes: { type: 'string' },
    /** Rebuild even when this version's Linux build already exists. */
    rebuild: { type: 'boolean', default: false },
  },
  strict: true,
});

if (process.platform !== 'win32') {
  fail(
    'Run this on the Windows publishing machine. On Linux, build with ' +
      `\`bash ${LINUX_BUILD_SCRIPT}\` and publish the folder from Windows.`
  );
}
if (!UPDATE_FEED_URL) fail('Set UPDATE_FEED_URL in app-identity.ts first');
const feedUrl = UPDATE_FEED_URL;
const builder = values.builder;
if (builder !== 'docker' && builder !== 'wsl') fail('--builder is docker or wsl');

const appDir = process.cwd();
const workspaceRoot = resolve(appDir, '../..');
if (!existsSync(join(workspaceRoot, LINUX_BUILD_SCRIPT))) {
  fail('Run this from apps/emdash-desktop');
}

function resolveRelease(): ReleaseRef {
  if (values.version && values.commit) {
    if (!isMaestroReleaseVersion(values.version))
      fail(`${values.version} is not a release version`);
    const commit = exec(`git rev-parse --verify ${shellSafe(values.commit)}^{commit}`, {
      cwd: workspaceRoot,
    });
    return { version: values.version, commit };
  }
  if (values.version || values.commit) fail('Pass both --version and --commit, or neither');
  const buildsRoot = updateBuildsRoot();
  const stateFile = buildsRoot ? join(buildsRoot, 'last-release.json') : null;
  if (!stateFile || !existsSync(stateFile)) {
    fail('No last-release.json from /push; pass --version and --commit');
  }
  return parseLastRelease(readFileSync(stateFile, 'utf8'));
}

function shellSafe(value: string): string {
  if (!/^[0-9A-Za-z._/-]+$/.test(value)) fail(`Unexpected characters in "${value}"`);
  return value;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { stdio: 'inherit', env: env ?? process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${String(result.status)}`);
}

/** The Windows release's notes, when the live Windows manifest is this very version. */
async function windowsManifest(): Promise<Record<string, unknown> | null> {
  const name = manifestFileName(UPDATE_CHANNEL);
  try {
    const text = await getBlobText(feedBlobUrl(feedUrl, name), name);
    return text === null ? null : parseManifest(text);
  } catch (error) {
    warn(`Could not read the live Windows manifest: ${String(error)}`);
    return null;
  }
}

function remoteLogsEnv(): Record<string, string> {
  const file =
    process.env.MAESTRO_REMOTE_LOGS_FILE ??
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Chorus', 'ReleaseConfig', 'remote-logs.json')
      : null);
  if (!file || !existsSync(file)) {
    info('remote logs: not built in (no remote-logs.json), as in a /push without it');
    return {};
  }
  const env = remoteLogsBuildEnv(readFileSync(file, 'utf8'));
  info(`remote logs: built in for ${new URL(env.MAIN_VITE_REMOTE_LOGS_URL ?? '').host}`);
  return env;
}

function uploadSas(): string {
  const existing = process.env[UPLOAD_SAS_ENV]?.trim();
  if (existing) return existing;
  const { account, container } = feedStorageTarget(feedUrl);
  const expiry = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 16) + 'Z';
  const sas = execOrNull(
    `az storage container generate-sas --account-name ${account} -n ${container} ` +
      `--permissions rcw --expiry ${expiry} --https-only --auth-mode login --as-user -o tsv`
  );
  if (!sas || !/(^|&)sig=/.test(sas)) {
    fail(`Could not create an upload SAS: sign in with \`az login\` or set ${UPLOAD_SAS_ENV}`);
  }
  return sas;
}

function hasLinuxBuild(dir: string, version: string): boolean {
  const manifestPath = join(dir, manifestFileName(UPDATE_CHANNEL, 'linux'));
  if (!existsSync(manifestPath)) return false;
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  return (
    manifest.version === version && readdirSync(dir).some((name) => name.endsWith('.AppImage'))
  );
}

async function main(): Promise<void> {
  const release = resolveRelease();
  info(`Release ${release.version} from commit ${release.commit}`);
  const buildsRoot = linuxUpdateBuildsRoot();
  if (!buildsRoot) fail('LOCALAPPDATA is not set');
  const outDir = join(buildsRoot, release.version);

  const windows = await windowsManifest();
  const windowsVersion = typeof windows?.version === 'string' ? windows.version : null;
  if (windowsVersion && windowsVersion !== release.version) {
    warn(
      `The feed's Windows release is ${windowsVersion}, not ${release.version}: client and host ` +
        'will only match once both platforms carry the same version'
    );
  }
  const notes =
    values.notes ??
    (windowsVersion === release.version && typeof windows?.releaseNotes === 'string'
      ? windows.releaseNotes
      : `Built from commit ${release.commit.slice(0, 12)}.`);

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...remoteLogsEnv(),
    MAESTRO_NOTES: notes,
  };
  const image = values.image ?? process.env.MAESTRO_LINUX_BUILD_IMAGE ?? DEFAULT_LINUX_BUILD_IMAGE;
  const distro = values.distro;
  const wslPrefix = distro ? ['-d', distro] : [];
  const command =
    builder === 'docker'
      ? {
          file: 'docker',
          args: dockerBuildArgs({ image, repoDir: workspaceRoot, outDir, release }),
        }
      : {
          file: 'wsl.exe',
          args: [
            ...wslPrefix,
            '-e',
            'bash',
            toWslPath(join(workspaceRoot, LINUX_BUILD_SCRIPT)),
            '--source',
            toWslPath(workspaceRoot),
            '--commit',
            release.commit,
            '--version',
            release.version,
            '--out',
            toWslPath(outDir),
          ],
        };

  if (values.check) {
    step(`Checking the ${builder} builder`);
    if (builder === 'docker') {
      info(`docker server ${exec('docker version --format "{{.Server.Version}}"')}`);
      const present = execOrNull(
        `docker image inspect ${shellSafeImage(image)} --format "{{.Id}}"`
      );
      info(present ? `image ${image} is present` : `image ${image} will be pulled`);
    } else {
      run('wsl.exe', [
        ...wslPrefix,
        '-e',
        'bash',
        toWslPath(join(workspaceRoot, LINUX_BUILD_SCRIPT)),
        '--check',
      ]);
    }
    info(`would run: ${command.file} ${command.args.join(' ')}`);
    info(`would publish ${outDir} as ${manifestFileName(UPDATE_CHANNEL, 'linux')}`);
    return;
  }

  if (hasLinuxBuild(outDir, release.version) && !values.rebuild) {
    info(`${outDir} already holds the Linux build of ${release.version}`);
  } else {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      if (!values.rebuild)
        fail(`${outDir} holds an incomplete build; pass --rebuild to replace it`);
      rmSync(outDir, { recursive: true, force: true });
    }
    mkdirSync(outDir, { recursive: true });
    step(`Building the Linux AppImage with ${builder} (10 to 20 minutes the first time)`);
    if (builder === 'wsl') buildEnv.WSLENV = wslEnv(process.env.WSLENV);
    run(command.file, command.args, buildEnv);
    if (!hasLinuxBuild(outDir, release.version)) fail(`The build left no AppImage in ${outDir}`);
  }

  step(values.publish ? 'Publishing the Linux release' : 'Dry run of the Linux publish');
  const publishArgs = [
    '--experimental-strip-types',
    'scripts/release/publish-maestro-update.ts',
    '--platform',
    'linux',
    '--dir',
    outDir,
    ...(values.publish ? ['--publish'] : []),
  ];
  run(
    process.execPath,
    publishArgs,
    values.publish ? { ...process.env, [UPLOAD_SAS_ENV]: uploadSas() } : process.env
  );
  if (!values.publish) info('Pass --publish to upload the Linux release');
}

function shellSafeImage(image: string): string {
  if (!/^[0-9A-Za-z._/:@-]+$/.test(image)) fail(`Unexpected characters in image "${image}"`);
  return image;
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
