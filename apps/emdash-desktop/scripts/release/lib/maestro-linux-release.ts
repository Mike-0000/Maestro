import { win32 } from 'node:path';
import { isMaestroReleaseVersion } from './maestro-update.ts';

// Pure helpers for maestro-linux-release.ts, the Windows-side driver of the Linux release leg.

/** Default image for the Docker build: Debian 12 (glibc 2.36), so the AppImage runs on Ubuntu 22.04+. */
export const DEFAULT_LINUX_BUILD_IMAGE = 'node:24-bookworm';
/** Docker volume holding the build checkout, node_modules and download caches between runs. */
export const LINUX_BUILD_VOLUME = 'maestro-linux-build';
/** The script that runs inside the container (or WSL, or on the host), relative to the repo. */
export const LINUX_BUILD_SCRIPT =
  'apps/emdash-desktop/scripts/release/linux/build-linux-release.sh';
/** Environment passed into the Linux build: release notes and the remote-logs settings. */
export const LINUX_BUILD_ENV = [
  'MAESTRO_NOTES',
  'MAIN_VITE_REMOTE_LOGS_URL',
  'MAIN_VITE_REMOTE_LOGS_KEY',
] as const;

export type ReleaseRef = { version: string; commit: string };

/** `/push` records each published release in `UpdateBuilds\last-release.json`. */
export function parseLastRelease(text: string): ReleaseRef {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  const { version, commit } = (parsed ?? {}) as { version?: unknown; commit?: unknown };
  if (typeof version !== 'string' || !isMaestroReleaseVersion(version)) {
    throw new Error('last-release.json has no Maestro release version');
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('last-release.json has no full commit id');
  }
  return { version, commit };
}

/** `C:\Users\me\x` -> `/mnt/c/Users/me/x`, the path a WSL distro sees. */
export function toWslPath(windowsPath: string): string {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(win32.normalize(windowsPath));
  if (!match) throw new Error(`${windowsPath} is not on a drive letter WSL can reach`);
  const rest = match[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** `https://<account>.blob.core.windows.net/<container>` -> its account and container. */
export function feedStorageTarget(feedUrl: string): { account: string; container: string } {
  const url = new URL(feedUrl);
  const host = /^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/.exec(url.hostname);
  const container = /^\/([a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?)\/?$/.exec(url.pathname);
  if (!host || !container) throw new Error(`${feedUrl} is not an Azure Blob container URL`);
  return { account: host[1], container: container[1] };
}

/**
 * The remote-logs settings `/push` bakes into the main bundle, so the Linux build matches the
 * Windows one. Same rule as `/push`: only an https URL and a publishable or anon key.
 */
export function remoteLogsBuildEnv(text: string): Record<string, string> {
  const config = JSON.parse(text.replace(/^\uFEFF/, '')) as { url?: unknown; anonKey?: unknown };
  const url = typeof config?.url === 'string' ? config.url.trim().replace(/\/+$/, '') : '';
  const key = typeof config?.anonKey === 'string' ? config.anonKey.trim() : '';
  let role: unknown = null;
  if (key.startsWith('eyJ')) {
    try {
      const payload = Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8');
      role = (JSON.parse(payload) as { role?: unknown }).role ?? null;
    } catch {
      role = null;
    }
  }
  const publishable =
    key.startsWith('sb_publishable_') || (key.startsWith('eyJ') && role === 'anon');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) || !publishable) {
    throw new Error('remote-logs.json needs an https "url" and a publishable or anon "anonKey"');
  }
  return { MAIN_VITE_REMOTE_LOGS_URL: url, MAIN_VITE_REMOTE_LOGS_KEY: key };
}

/** Arguments of the `docker run` that builds the AppImage of `release` into `outDir`. */
export function dockerBuildArgs(options: {
  image: string;
  repoDir: string;
  outDir: string;
  release: ReleaseRef;
  volume?: string;
}): string[] {
  const volume = options.volume ?? LINUX_BUILD_VOLUME;
  return [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    // The checkout is read only: the build clones the commit out of it into the volume.
    '-v',
    `${options.repoDir}:/repo:ro`,
    '-v',
    `${options.outDir}:/out`,
    '-v',
    `${volume}:/work`,
    // Values come from this process's environment, so nothing secret is on the command line.
    ...LINUX_BUILD_ENV.flatMap((name) => ['-e', name]),
    options.image,
    'bash',
    `/repo/${LINUX_BUILD_SCRIPT}`,
    '--source',
    '/repo',
    '--commit',
    options.release.commit,
    '--version',
    options.release.version,
    '--out',
    '/out',
    '--work',
    '/work',
  ];
}

/** `WSLENV` that forwards the build environment into a distro, keeping any existing entries. */
export function wslEnv(existing: string | undefined): string {
  const entries = (existing ?? '').split(':').filter(Boolean);
  for (const name of LINUX_BUILD_ENV) {
    if (!entries.some((entry) => entry.split('/')[0] === name)) entries.push(`${name}/u`);
  }
  return entries.join(':');
}
