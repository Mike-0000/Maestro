import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  exportUpdateSigningPublicKey,
  signUpdateManifest,
  UPDATE_SIGNATURE_FIELD,
  verifyUpdateManifest,
} from './update-manifest-signature';

const { privateKey } = generateKeyPairSync('ed25519');
const trusted = [exportUpdateSigningPublicKey(createPublicKey(privateKey))];

function manifest(): Record<string, unknown> {
  return {
    version: '1.2.6-maestro.202609291530',
    files: [
      {
        url: 'releases/1.2.6-maestro.202609291530/maestro-x64.exe',
        sha512: 'c2hhNTEy',
        size: 1234,
      },
    ],
    path: 'releases/1.2.6-maestro.202609291530/maestro-x64.exe',
    sha512: 'c2hhNTEy',
    releaseDate: '2026-09-29T15:30:00.000Z',
    releaseNotes: 'Built from commit abc.',
  };
}

function signed(): Record<string, unknown> {
  const base = manifest();
  return { ...base, [UPDATE_SIGNATURE_FIELD]: signUpdateManifest(base, privateKey) };
}

describe('update manifest signatures', () => {
  it('accepts a manifest signed by a trusted key', () => {
    expect(verifyUpdateManifest(signed(), trusted).version).toBe('1.2.6-maestro.202609291530');
  });

  it('ignores fields the updater does not act on', () => {
    expect(() =>
      verifyUpdateManifest({ ...signed(), releaseDate: new Date() }, trusted)
    ).not.toThrow();
  });

  it('rejects an unsigned manifest', () => {
    expect(() => verifyUpdateManifest(manifest(), trusted)).toThrow(/not signed/);
  });

  it('rejects a signature from an untrusted key', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const base = manifest();
    const forged = { ...base, [UPDATE_SIGNATURE_FIELD]: signUpdateManifest(base, other) };
    expect(() => verifyUpdateManifest(forged, trusted)).toThrow(/not trusted/);
  });

  it.each([
    ['version', { version: '9.9.9' }],
    [
      'installer hash',
      { files: [{ url: 'releases/x/maestro-x64.exe', sha512: 'ZXZpbA==', size: 1234 }] },
    ],
    ['release notes', { releaseNotes: 'Download the fix from https://example.invalid' }],
    [
      'elevation flag',
      { files: [{ ...(manifest().files as object[])[0], isAdminRightsRequired: true }] },
    ],
    ['rollout percentage', { stagingPercentage: 0 }],
  ])('rejects a changed %s', (_label, change) => {
    expect(() => verifyUpdateManifest({ ...signed(), ...change }, trusted)).toThrow(
      /does not match its signed contents/
    );
  });

  it('rejects a tampered payload even when the manifest matches it', () => {
    const tampered = signed();
    const signature = tampered[UPDATE_SIGNATURE_FIELD] as { payload: string };
    const payload = JSON.parse(Buffer.from(signature.payload, 'base64').toString('utf8'));
    payload.version = '9.9.9';
    signature.payload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    expect(() => verifyUpdateManifest({ ...tampered, version: '9.9.9' }, trusted)).toThrow(
      /signature is invalid/
    );
  });

  it('never signs or accepts web-installer packages', () => {
    const base = { ...manifest(), packages: { x64: { path: 'evil.7z' } } };
    expect(() => signUpdateManifest(base, privateKey)).toThrow(/web-installer/);
    expect(() => verifyUpdateManifest({ ...signed(), packages: base.packages }, trusted)).toThrow(
      /web-installer/
    );
  });
});
