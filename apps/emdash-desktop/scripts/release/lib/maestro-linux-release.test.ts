import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportUpdateSigningPublicKey,
  verifyUpdateManifest,
} from '../../../src/main/host/updates/update-manifest-signature.ts';
import {
  dockerBuildArgs,
  feedStorageTarget,
  LINUX_BUILD_SCRIPT,
  parseLastRelease,
  remoteLogsBuildEnv,
  toWslPath,
  wslEnv,
} from './maestro-linux-release.ts';
import { parseManifest, relocateManifest, signManifest } from './maestro-update.ts';

const VERSION = '1.2.6-maestro.202611241755';
const COMMIT = '8d94a5dbdb9b3d636b80a2378088c8bac868cbbf';

describe('the Linux release leg', () => {
  it('reads the release /push recorded', () => {
    const text = `\uFEFF${JSON.stringify({ version: VERSION, commit: COMMIT, publishedAt: 'x' })}`;
    expect(parseLastRelease(text)).toEqual({ version: VERSION, commit: COMMIT });
    expect(() => parseLastRelease('{"version":"1.2.6","commit":"abc"}')).toThrow(/version/);
    expect(() => parseLastRelease(`{"version":"${VERSION}","commit":"abc"}`)).toThrow(/commit/);
  });

  it('maps Windows paths to the paths WSL sees', () => {
    expect(toWslPath('C:\\Github\\chorus')).toBe('/mnt/c/Github/chorus');
    expect(toWslPath('D:/builds/1.0\\')).toBe('/mnt/d/builds/1.0');
    expect(() => toWslPath('\\\\server\\share')).toThrow(/drive letter/);
  });

  it('finds the storage account and container of the feed', () => {
    expect(feedStorageTarget('https://stmaestroupdd5313e.blob.core.windows.net/maestro')).toEqual({
      account: 'stmaestroupdd5313e',
      container: 'maestro',
    });
    expect(() => feedStorageTarget('https://example.com/maestro')).toThrow(/Azure Blob/);
  });

  it('builds in a read-only checkout with secrets passed by name only', () => {
    const args = dockerBuildArgs({
      image: 'node:24-bookworm',
      repoDir: 'C:\\Github\\chorus',
      outDir: 'C:\\out\\v',
      release: { version: VERSION, commit: COMMIT },
    });
    expect(args).toContain('C:\\Github\\chorus:/repo:ro');
    expect(args).toContain('maestro-linux-build:/work');
    expect(args).toContain(`/repo/${LINUX_BUILD_SCRIPT}`);
    expect(args.join(' ')).toContain(`--commit ${COMMIT} --version ${VERSION} --out /out`);
    expect(args.filter((arg) => arg.includes('='))).toEqual([]);
  });

  it('forwards the build environment into WSL without dropping existing entries', () => {
    expect(wslEnv(undefined)).toBe(
      'MAESTRO_NOTES/u:MAIN_VITE_REMOTE_LOGS_URL/u:MAIN_VITE_REMOTE_LOGS_KEY/u'
    );
    expect(wslEnv('FOO/p:MAESTRO_NOTES/u')).toBe(
      'FOO/p:MAESTRO_NOTES/u:MAIN_VITE_REMOTE_LOGS_URL/u:MAIN_VITE_REMOTE_LOGS_KEY/u'
    );
  });

  it('builds in only a publishable remote-logs key, like /push', () => {
    expect(
      remoteLogsBuildEnv('{"url":"https://abc.supabase.co/","anonKey":"sb_publishable_x"}')
    ).toEqual({
      MAIN_VITE_REMOTE_LOGS_URL: 'https://abc.supabase.co',
      MAIN_VITE_REMOTE_LOGS_KEY: 'sb_publishable_x',
    });
    const serviceRole = `eyJx.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig`;
    expect(() =>
      remoteLogsBuildEnv(JSON.stringify({ url: 'https://abc.supabase.co', anonKey: serviceRole }))
    ).toThrow(/publishable/);
  });

  it('signs a Linux AppImage manifest that the installed app verifies', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const trusted = [exportUpdateSigningPublicKey(createPublicKey(privateKey))];
    const built = parseManifest(
      [
        `version: ${VERSION}`,
        'files:',
        '  - url: maestro-x86_64.AppImage',
        '    sha512: c2hh',
        '    size: 123',
        '    blockMapSize: 45',
        'path: maestro-x86_64.AppImage',
        'sha512: c2hh',
        "releaseDate: '2026-11-24T17:58:15.026Z'",
      ].join('\n')
    );
    const { manifest, uploads } = relocateManifest(built, VERSION);
    expect(uploads).toEqual([
      {
        localName: 'maestro-x86_64.AppImage',
        blobPath: `releases/${VERSION}/maestro-x86_64.AppImage`,
      },
    ]);
    const payload = verifyUpdateManifest(
      parseManifest(signManifest(manifest, privateKey, trusted)),
      trusted
    );
    expect(payload.version).toBe(VERSION);
    expect(payload.files[0]?.url).toBe(`releases/${VERSION}/maestro-x86_64.AppImage`);
  });
});
