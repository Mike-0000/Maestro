import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportUpdateSigningPublicKey,
  verifyUpdateManifest,
} from '../../../src/main/host/updates/update-manifest-signature.ts';
import {
  compareSemver,
  feedBlobUrl,
  isMaestroReleaseVersion,
  latestUpdateBuild,
  linuxUpdateBuildsRoot,
  maestroPackaging,
  maestroReleaseVersion,
  manifestFileName,
  parseMaestroPlatform,
  parseManifest,
  relocateManifest,
  signManifest,
  trustedKeyIdFor,
} from './maestro-update.ts';

const VERSION = '1.2.6-maestro.202609291530';

describe('maestro release versions', () => {
  it('stamps the upstream version with a UTC minute', () => {
    expect(maestroReleaseVersion('1.2.6', new Date('2026-09-29T15:30:59Z'))).toBe(VERSION);
    expect(maestroReleaseVersion('1.2.6-canary.4', new Date('2026-01-02T03:04:00Z'))).toBe(
      '1.2.6-maestro.202601020304'
    );
  });

  it('orders by semantic version precedence', () => {
    expect(compareSemver('1.2.6-maestro.202609291531', VERSION)).toBe(1);
    expect(compareSemver('1.2.7-maestro.202601010000', VERSION)).toBe(1);
    expect(compareSemver(VERSION, '1.2.6')).toBe(-1);
    expect(compareSemver(VERSION, VERSION)).toBe(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('1.0.0-2', '1.0.0-10')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-2')).toBe(1);
  });
});

describe('feed urls', () => {
  it('keeps a read SAS for clients and swaps in the upload SAS', () => {
    const feed = 'https://acct.blob.core.windows.net/maestro/stable?sv=1&sig=read';
    expect(feedBlobUrl(feed, 'v1-stable.yml')).toBe(
      'https://acct.blob.core.windows.net/maestro/stable/v1-stable.yml?sv=1&sig=read'
    );
    expect(feedBlobUrl(feed, 'releases/1.0.0/a b.exe', '?sig=write')).toBe(
      'https://acct.blob.core.windows.net/maestro/stable/releases/1.0.0/a%20b.exe?sig=write'
    );
  });

  it('rejects insecure feeds and path traversal', () => {
    expect(() => feedBlobUrl('http://acct.blob.core.windows.net/maestro', 'x.yml')).toThrow(
      /HTTPS/
    );
    expect(() => feedBlobUrl('https://acct.blob.core.windows.net/maestro', '../x.yml')).toThrow();
  });
});

describe('release manifests', () => {
  const built = {
    version: VERSION,
    files: [{ url: 'maestro-x64.exe', sha512: 'c2hh', size: 10 }],
    path: 'maestro-x64.exe',
    sha512: 'c2hh',
    releaseDate: '2026-09-29T15:30:00.000Z',
  };

  it('moves files into the immutable release folder', () => {
    const { manifest, uploads } = relocateManifest(built, VERSION);
    expect(manifest.path).toBe(`releases/${VERSION}/maestro-x64.exe`);
    expect(manifest.files).toEqual([
      { ...built.files[0], url: `releases/${VERSION}/maestro-x64.exe` },
    ]);
    expect(uploads).toEqual([
      { localName: 'maestro-x64.exe', blobPath: `releases/${VERSION}/maestro-x64.exe` },
    ]);
  });

  it('refuses a manifest for another version', () => {
    expect(() => relocateManifest(built, '1.2.6-maestro.1')).toThrow(/does not match/);
  });

  it('signs a manifest that verifies after YAML round trip and keeps dates as strings', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const trusted = [exportUpdateSigningPublicKey(createPublicKey(privateKey))];
    expect(trustedKeyIdFor(privateKey, trusted)).toMatch(/^[0-9a-f]{16}$/);
    expect(trustedKeyIdFor(generateKeyPairSync('ed25519').privateKey, trusted)).toBeNull();

    const text = signManifest(relocateManifest(built, VERSION).manifest, privateKey, trusted);
    expect(text).toContain('releaseDate: "2026-09-29T15:30:00.000Z"');
    expect(verifyUpdateManifest(parseManifest(text), trusted).files[0]?.url).toBe(
      `releases/${VERSION}/maestro-x64.exe`
    );
  });
});

describe('update builds', () => {
  it('picks the newest build folder that holds a manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-builds-'));
    expect(latestUpdateBuild(join(root, 'missing'), 'v1-stable.yml')).toBeNull();
    for (const version of ['1.2.6-maestro.202609291530', '1.2.6-maestro.202609301200']) {
      mkdirSync(join(root, version));
      writeFileSync(join(root, version, 'v1-stable.yml'), '');
    }
    mkdirSync(join(root, '1.2.7-maestro.202610010000')); // interrupted build: no manifest
    mkdirSync(join(root, 'notes'));
    expect(latestUpdateBuild(root, 'v1-stable.yml')).toBe(join(root, '1.2.6-maestro.202609301200'));
  });
});

describe('platforms', () => {
  it('keeps the Windows manifest name and adds the Linux one electron-updater asks for', () => {
    expect(manifestFileName('v1-stable')).toBe('v1-stable.yml');
    expect(manifestFileName('v1-stable', 'win')).toBe('v1-stable.yml');
    expect(manifestFileName('v1-stable', 'linux')).toBe('v1-stable-linux.yml');
  });

  it('defaults to Windows and rejects unknown platforms', () => {
    expect(parseMaestroPlatform(undefined)).toBe('win');
    expect(parseMaestroPlatform('linux')).toBe('linux');
    expect(() => parseMaestroPlatform('mac')).toThrow(/Unknown platform/);
  });

  it('packages Windows exactly as before and compiles node-pty for Linux', () => {
    expect(maestroPackaging('win')).toEqual({ target: 'nsis', nativeModules: ['better-sqlite3'] });
    expect(maestroPackaging('linux')).toEqual({
      target: 'AppImage',
      nativeModules: ['better-sqlite3', 'node-pty'],
    });
  });

  it('accepts only release versions for a reused version', () => {
    expect(isMaestroReleaseVersion(VERSION)).toBe(true);
    expect(isMaestroReleaseVersion('1.2.6')).toBe(false);
    expect(isMaestroReleaseVersion('1.2.6-maestro.2026')).toBe(false);
  });

  it('keeps Linux builds out of the folder /push prunes', () => {
    expect(linuxUpdateBuildsRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })).toBe(
      'C:\\Users\\me\\AppData\\Local\\Chorus\\LinuxUpdateBuilds'
    );
    expect(linuxUpdateBuildsRoot({})).toBeNull();
  });
});
