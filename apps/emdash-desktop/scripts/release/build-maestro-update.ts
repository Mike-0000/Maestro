// Builds a Windows NSIS installer and its update manifest for the Maestro auto-update feed.
// Nothing is uploaded; run publish-maestro-update.ts afterwards. See docs/chorus/auto-update.md.
import { readFileSync, rmSync } from 'node:fs';
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
  MAESTRO_UPDATE_OUTPUT,
  manifestFileName,
  maestroReleaseVersion,
  parseManifest,
} from './lib/maestro-update.ts';

const { values } = parseArgs({
  // `pnpm run <script> -- --flag` forwards the separator itself.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--'),
  options: {
    notes: { type: 'string' },
    'allow-dirty': { type: 'boolean', default: false },
    'skip-workspace-build': { type: 'boolean', default: false },
  },
  strict: true,
});

if (process.platform !== 'win32') fail('Maestro update installers are built on Windows');
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
const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;
const version = maestroReleaseVersion(packageVersion, new Date());
info(`Version ${version} from commit ${commit}${status ? ' (with uncommitted changes)' : ''}`);

if (!values['skip-workspace-build']) {
  step('Building workspace packages and the app bundle');
  exec('pnpm run build', { cwd: workspaceRoot, echo: true });
}

// electron-builder runs with npmRebuild: false, so compile the SQLite addon for Electron's ABI
// explicitly, as the local delivery coordinator does.
step('Rebuilding native modules for Electron');
exec('pnpm exec electron-rebuild -f --only=better-sqlite3', { echo: true });

step('Packaging the Windows installer');
rmSync(MAESTRO_UPDATE_OUTPUT, { recursive: true, force: true });
const electronVersion = exec(`node -p "require('electron/package.json').version"`);
const config = createReleaseBuildConfig(stableConfig, electronVersion, version);
await electronBuild({
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: {
    ...config,
    directories: { ...config.directories, output: MAESTRO_UPDATE_OUTPUT },
    releaseInfo: {
      releaseName: `Maestro ${version}`,
      releaseNotes: values.notes ?? `Built from commit ${commit.slice(0, 12)}.`,
    },
  },
  publish: 'never',
});

const manifestPath = join(MAESTRO_UPDATE_OUTPUT, manifestFileName(UPDATE_CHANNEL));
const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  fail(`${manifestPath} has version ${String(manifest.version)}, expected ${version}`);
}
info(`Built ${manifestPath}`);
info('Next: pnpm run updates:publish        (dry run: signs and shows the upload plan)');
info('      pnpm run updates:publish --publish');
