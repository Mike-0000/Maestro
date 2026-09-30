import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, win32 } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  exportUpdateSigningPublicKey,
  signUpdateManifest,
  UPDATE_SIGNATURE_FIELD,
  updateSigningKeyId,
  verifyUpdateManifest,
} from '../../../src/main/host/updates/update-manifest-signature.ts';

/** Overrides the default private-key location used by the Maestro update scripts. */
export const SIGNING_KEY_ENV = 'MAESTRO_UPDATE_SIGNING_KEY_FILE';
/** Container-scoped SAS token (create + write; no delete needed) used only for uploads. */
export const UPLOAD_SAS_ENV = 'MAESTRO_AZURE_UPLOAD_SAS';
/** Blob folder holding each release's immutable files. */
export const RELEASES_PREFIX = 'releases';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const MANIFEST_CACHE_CONTROL = 'no-cache';

type Manifest = Record<string, unknown>;
type Environment = Partial<Record<string, string>>;

export function defaultSigningKeyFile(environment: Environment = process.env): string | null {
  if (environment[SIGNING_KEY_ENV]) return environment[SIGNING_KEY_ENV];
  return environment.LOCALAPPDATA
    ? win32.join(environment.LOCALAPPDATA, 'Chorus', 'UpdateSigning', 'maestro-update-signing.pem')
    : null;
}

/**
 * Parent of the per-version build folders written by build-maestro-update.ts. It lives outside the
 * checkout: on Windows, packaging under apps/emdash-desktop/release/ fails with EPERM when
 * electron-builder renames its freshly extracted Electron folder.
 */
export function updateBuildsRoot(environment: Environment = process.env): string | null {
  return environment.LOCALAPPDATA
    ? win32.join(environment.LOCALAPPDATA, 'Chorus', 'UpdateBuilds')
    : null;
}

/** The highest-versioned build folder under `root` that holds a manifest, if any. */
export function latestUpdateBuild(root: string, manifestName: string): string | null {
  if (!existsSync(root)) return null;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SEMVER.test(entry.name))
    .filter((entry) => existsSync(win32.join(root, entry.name, manifestName)))
    .map((entry) => entry.name)
    .sort(compareSemver);
  const latest = versions.at(-1);
  return latest ? win32.join(root, latest) : null;
}

export function loadSigningKey(file: string): KeyObject {
  const key = createPrivateKey(readFileSync(file, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  return key;
}

/** Returns the key id when the private key's public half is one of the app's trusted keys. */
export function trustedKeyIdFor(
  privateKey: KeyObject,
  trustedPublicKeys: readonly string[]
): string | null {
  const publicKey = createPublicKey(privateKey);
  return trustedPublicKeys.includes(exportUpdateSigningPublicKey(publicKey))
    ? updateSigningKeyId(publicKey)
    : null;
}

/**
 * Published versions extend the upstream version with a UTC timestamp, so every publish sorts
 * after the previous one and after any older upstream base: 1.2.6 -> 1.2.6-maestro.202609291530.
 */
export function maestroReleaseVersion(packageVersion: string, now: Date): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(packageVersion);
  if (!match) throw new Error(`Unsupported package version "${packageVersion}"`);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}`;
  return `${match[1]}.${match[2]}.${match[3]}-maestro.${stamp}`;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semantic Versioning 2.0 precedence: negative, zero, or positive like a sort comparator. */
export function compareSemver(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) throw new Error(`Invalid semantic version: ${left ? b : a}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = left[4]?.split('.') ?? [];
  const rightPre = right[4]?.split('.') ?? [];
  if (leftPre.length === 0 || rightPre.length === 0)
    return Math.sign(rightPre.length - leftPre.length);
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const l = leftPre[index];
    const r = rightPre[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return Math.sign(Number(l) - Number(r));
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** HTTPS feed base (container or folder URL); its query, if any, is a read-only SAS. */
export function parseFeedUrl(feedUrl: string): URL {
  const url = new URL(feedUrl);
  if (url.protocol !== 'https:') throw new Error('The update feed must use HTTPS');
  if (url.hash) throw new Error('The update feed URL must not contain a fragment');
  return url;
}

/** URL of a blob under the feed. `query` replaces the feed's own query (e.g. an upload SAS). */
export function feedBlobUrl(feedUrl: string, blobPath: string, query?: string): string {
  const url = parseFeedUrl(feedUrl);
  const segments = blobPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid blob path "${blobPath}"`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${segments.map(encodeURIComponent).join('/')}`;
  if (query !== undefined) url.search = query.replace(/^\?/, '');
  return url.toString();
}

export function releaseBlobPath(version: string, fileName: string): string {
  return `${RELEASES_PREFIX}/${version}/${fileName}`;
}

export function manifestFileName(channel: string): string {
  return `${channel}.yml`;
}

export interface ReleaseUpload {
  /** File name inside the local build directory. */
  localName: string;
  blobPath: string;
}

/**
 * Point every manifest file at the release's immutable folder. Keeping the version in the path lets
 * electron-updater derive the previous release's blockmap for differential downloads.
 */
export function relocateManifest(
  manifest: Manifest,
  version: string
): { manifest: Manifest; uploads: ReleaseUpload[] } {
  if (manifest.version !== version) {
    throw new Error(`Manifest version ${String(manifest.version)} does not match ${version}`);
  }
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('Manifest lists no files');
  const uploads = new Map<string, ReleaseUpload>();
  const relocate = (url: unknown): string => {
    if (typeof url !== 'string' || !url || url.includes('/') || url.includes('\\')) {
      throw new Error(`Expected a bare file name in the build manifest, got ${String(url)}`);
    }
    const blobPath = releaseBlobPath(version, url);
    uploads.set(url, { localName: url, blobPath });
    return blobPath;
  };
  const relocated: Manifest = {
    ...manifest,
    files: files.map((file: Manifest) => ({ ...file, url: relocate(file.url) })),
  };
  if (manifest.path !== undefined) relocated.path = relocate(manifest.path);
  delete relocated[UPDATE_SIGNATURE_FIELD];
  return { manifest: relocated, uploads: [...uploads.values()] };
}

export function parseManifest(text: string): Manifest {
  const manifest: unknown = parse(text);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('Update manifest is not a YAML mapping');
  }
  return manifest as Manifest;
}

/**
 * Double-quoted strings keep every value a string under any YAML 1.1/1.2 loader (the app uses
 * js-yaml, which would otherwise turn an unquoted ISO date into a Date).
 */
export function serializeManifest(manifest: Manifest): string {
  return stringify(manifest, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });
}

/** Sign, serialize, and prove the result verifies exactly as the installed app will check it. */
export function signManifest(
  manifest: Manifest,
  privateKey: KeyObject,
  trustedPublicKeys: readonly string[]
): string {
  const signed = {
    ...manifest,
    [UPDATE_SIGNATURE_FIELD]: signUpdateManifest(manifest, privateKey),
  };
  const text = serializeManifest(signed);
  verifyUpdateManifest(parseManifest(text), trustedPublicKeys);
  return text;
}

export function blockmapName(fileName: string): string {
  return `${basename(fileName)}.blockmap`;
}
