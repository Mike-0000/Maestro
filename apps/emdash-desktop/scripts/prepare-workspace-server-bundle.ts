import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// Windows hosts install the workspace server from this bundle over SSH, so Maestro does not
// depend on a hosted workspace-server release for them. See apps/workspace-server/docs/windows-hosts.md.
export const WORKSPACE_SERVER_BUNDLE_DIR = join(
  import.meta.dirname,
  '..',
  '.cache',
  'workspace-server-bundle'
);
const WORKSPACE_SERVER_DIR = join(import.meta.dirname, '..', '..', 'workspace-server');
const ARTIFACTS_DIR = join(WORKSPACE_SERVER_DIR, 'dist-artifacts');

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** True when the archive matches its sidecar, so a truncated copy is never shipped. */
async function artifactValid(archive: string, name: string): Promise<boolean> {
  if (!existsSync(archive) || !existsSync(`${archive}.sha256`)) return false;
  const [expected, sidecarName] = (await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/);
  return sidecarName === name && expected?.toLowerCase() === (await sha256File(archive));
}

function packageWindowsArtifact(): void {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('the win32-x64 workspace server can only be packaged on a Windows x64 host');
  }
  // Fixed arguments only; pnpm is a .cmd shim, so it has to go through cmd.exe.
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm run package --target win32-x64'], {
    cwd: WORKSPACE_SERVER_DIR,
    stdio: 'inherit',
  });
}

export async function prepareWorkspaceServerBundle(): Promise<void> {
  const { version } = JSON.parse(
    await readFile(join(WORKSPACE_SERVER_DIR, 'package.json'), 'utf8')
  ) as { version: string };
  const name = `emdash-workspace-server-${version}-win32-x64.zip`;
  const archive = join(ARTIFACTS_DIR, name);
  const bundled = join(WORKSPACE_SERVER_BUNDLE_DIR, name);

  await mkdir(WORKSPACE_SERVER_BUNDLE_DIR, { recursive: true });
  if (!(await artifactValid(bundled, name))) {
    if (!(await artifactValid(archive, name))) {
      try {
        packageWindowsArtifact();
      } catch (error) {
        if (process.env.MAESTRO_REQUIRE_WINDOWS_WORKSPACE_SERVER === '1') throw error;
        // Windows hosts then fall back to the configured workspace-server release channel.
        console.warn(
          `Skipping the bundled Windows workspace server: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await rm(WORKSPACE_SERVER_BUNDLE_DIR, { recursive: true, force: true });
        await mkdir(WORKSPACE_SERVER_BUNDLE_DIR, { recursive: true });
        return;
      }
      if (!(await artifactValid(archive, name))) {
        throw new Error(`Packaging did not produce a verified ${name}`);
      }
    }
    await copyFile(archive, bundled);
    await copyFile(`${archive}.sha256`, `${bundled}.sha256`);
  }
  // Only one version may be bundled; the desktop refuses an ambiguous bundle.
  const keep = new Set([name, `${name}.sha256`, 'install.ps1']);
  for (const entry of await readdir(WORKSPACE_SERVER_BUNDLE_DIR)) {
    if (!keep.has(entry)) {
      await rm(join(WORKSPACE_SERVER_BUNDLE_DIR, entry), { recursive: true, force: true });
    }
  }
  // install.ps1 is small and versioned with the source tree; always ship the current copy.
  await copyFile(
    join(WORKSPACE_SERVER_DIR, 'install.ps1'),
    join(WORKSPACE_SERVER_BUNDLE_DIR, 'install.ps1')
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await prepareWorkspaceServerBundle();
}
