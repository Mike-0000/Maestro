// Builds a Maestro release and its update manifest for the Maestro auto-update feed: the Windows
// NSIS installer (the default, on Windows), or with `--platform linux` the x64 AppImage a Linux host
// runs (on x64 Linux: the Docker or WSL leg of maestro-linux-release.ts, or the host itself).
// Nothing is uploaded; run publish-maestro-update.ts afterwards. See docs/chorus/auto-update.md.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Arch, Platform, build as electronBuild } from 'electron-builder';
import stableConfig from '../../electron-builder.config.ts';
import {
  UPDATE_CHANNEL,
  UPDATE_FEED_URL,
  UPDATES_ENABLED,
} from '../../src/core/primitives/app-identity/api/app-identity.ts';
import { createReleaseBuildConfig } from './lib/build-config.ts';
import { exec } from './lib/exec.ts';
import { fail, info, step } from './lib/log.ts';
import {
  isMaestroReleaseVersion,
  maestroPackaging,
  manifestFileName,
  maestroReleaseVersion,
  parseMaestroPlatform,
  parseManifest,
  updateBuildsRoot,
} from './lib/maestro-update.ts';

const { values } = parseArgs({
  // `pnpm run <script> -- --flag` forwards the separator itself.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--'),
  options: {
    notes: { type: 'string' },
    'allow-dirty': { type: 'boolean', default: false },
    'skip-workspace-build': { type: 'boolean', default: false },
    /** `win` (default) or `linux`. */
    platform: { type: 'string' },
    /** Reuse an existing release version (the Linux leg takes the Windows build's). */
    version: { type: 'string' },
    /** Fail unless HEAD is this commit. */
    commit: { type: 'string' },
    /** Build folder; defaults to UpdateBuilds\<version> on Windows, ~/.cache on Linux. */
    output: { type: 'string' },
  },
  strict: true,
});

let platform: ReturnType<typeof parseMaestroPlatform>;
try {
  platform = parseMaestroPlatform(values.platform);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (platform === 'win' && process.platform !== 'win32') {
  fail('Maestro update installers are built on Windows');
}
if (platform === 'linux' && (process.platform !== 'linux' || process.arch !== 'x64')) {
  fail('The Linux AppImage is built on x64 Linux: run scripts/release/maestro-linux-release.ts');
}
if (!UPDATES_ENABLED || !UPDATE_FEED_URL) {
  fail(
    'Set UPDATE_FEED_URL and UPDATE_SIGNING_PUBLIC_KEYS in app-identity.ts first; otherwise the ' +
      'installed app would have no update feed (see docs/chorus/auto-update.md)'
  );
}

const appDir = process.cwd();
const workspaceRoot = resolve(appDir, '../..');
const status = exec('git status --porcelain', { cwd: workspaceRoot });
if (status && !values['allow-dirty']) {
  fail('The checkout has uncommitted changes; publish only committed, validated code');
}
const commit = exec('git rev-parse HEAD', { cwd: workspaceRoot });
if (values.commit && values.commit !== commit) {
  fail(`HEAD is ${commit}, expected ${values.commit}`);
}
const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;
if (values.version !== undefined && !isMaestroReleaseVersion(values.version)) {
  fail(`--version ${values.version} is not a Maestro release version (x.y.z-maestro.<stamp>)`);
}
const version = values.version ?? maestroReleaseVersion(packageVersion, new Date());
let outputDir: string;
if (values.output) {
  outputDir = resolve(values.output);
} else if (platform === 'linux') {
  outputDir = join(homedir(), '.cache', 'maestro-update-builds', version);
} else {
  const buildsRoot = updateBuildsRoot();
  if (!buildsRoot) fail('LOCALAPPDATA is not set');
  outputDir = join(buildsRoot, version);
}
if (existsSync(outputDir)) fail(`${outputDir} already exists; wait a minute and build again`);
info(`Version ${version} from commit ${commit}${status ? ' (with uncommitted changes)' : ''}`);

if (!values['skip-workspace-build']) {
  step('Building workspace packages and the app bundle');
  exec('pnpm run build', { cwd: workspaceRoot, echo: true });
}

// electron-builder runs with npmRebuild: false, so compile the native addons for Electron's ABI
// explicitly, as the local delivery coordinator does.
const packaging = maestroPackaging(platform);
step('Rebuilding native modules for Electron');
exec(`pnpm exec electron-rebuild -f --only=${packaging.nativeModules.join(',')}`, { echo: true });

step(platform === 'linux' ? 'Packaging the Linux AppImage' : 'Packaging the Windows installer');
const electronVersion = exec(`node -p "require('electron/package.json').version"`);
const config = createReleaseBuildConfig(stableConfig, electronVersion, version);
await electronBuild({
  targets:
    platform === 'linux'
      ? Platform.LINUX.createTarget([packaging.target], Arch.x64)
      : Platform.WINDOWS.createTarget([packaging.target], Arch.x64),
  config: {
    ...config,
    directories: { ...config.directories, output: outputDir },
    releaseInfo: {
      releaseName: `Maestro ${version}`,
      releaseNotes: values.notes ?? `Built from commit ${commit.slice(0, 12)}.`,
    },
  },
  publish: 'never',
});

const manifestPath = join(outputDir, manifestFileName(UPDATE_CHANNEL, platform));
const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  fail(`${manifestPath} has version ${String(manifest.version)}, expected ${version}`);
}
info(`Built ${manifestPath}`);
if (platform === 'linux') {
  info('Next, on the Windows machine that holds the signing key:');
  info('      pnpm run updates:publish -- --platform linux --dir <this folder>   (dry run)');
} else {
  info('Next: pnpm run updates:publish        (dry run: signs and shows the upload plan)');
  info('      pnpm run updates:publish --publish');
}
