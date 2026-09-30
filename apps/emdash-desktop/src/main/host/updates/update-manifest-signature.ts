import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// No local imports: release scripts load this module under Node --experimental-strip-types.

/** Manifest field holding the detached Ed25519 signature written by the publish script. */
export const UPDATE_SIGNATURE_FIELD = 'maestroSignature';

/**
 * The manifest fields electron-updater acts on, in a fixed order. The publisher signs the JSON
 * form of this projection; the app recomputes it from the manifest it fetched and requires the
 * exact signed bytes, so YAML formatting differences never matter and no acted-on field can change.
 */
export interface SignedUpdatePayload {
  v: 1;
  version: string;
  releaseName: string | null;
  releaseNotes: string | Array<{ version: string | null; note: string | null }> | null;
  minimumSystemVersion: string | null;
  stagingPercentage: number | null;
  path: string | null;
  sha512: string | null;
  files: Array<{
    url: string;
    sha512: string;
    size: number | null;
    isAdminRightsRequired: boolean;
  }>;
}

export interface UpdateManifestSignature {
  keyId: string;
  payload: string;
  signature: string;
}

export class UpdateSignatureError extends Error {
  constructor(message: string) {
    super(`Update manifest rejected: ${message}`);
    this.name = 'UpdateSignatureError';
  }
}

type Manifest = Record<string, unknown>;

function optionalString(manifest: Manifest, key: string): string | null {
  const value = manifest[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new UpdateSignatureError(`"${key}" must be a string`);
  return value;
}

function normalizeReleaseNotes(value: unknown): SignedUpdatePayload['releaseNotes'] {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new UpdateSignatureError('"releaseNotes" is malformed');
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new UpdateSignatureError('"releaseNotes" is malformed');
    }
    const note = entry as Manifest;
    return { version: optionalString(note, 'version'), note: optionalString(note, 'note') };
  });
}

export function projectUpdateManifest(manifest: Manifest): SignedUpdatePayload {
  const version = optionalString(manifest, 'version');
  if (!version) throw new UpdateSignatureError('"version" is missing');
  // Web-installer packages are downloaded from a separate, unsigned field; never accept them.
  if (manifest.packages !== undefined && manifest.packages !== null) {
    throw new UpdateSignatureError('web-installer packages are not supported');
  }
  const staging = manifest.stagingPercentage;
  if (staging !== undefined && staging !== null && typeof staging !== 'number') {
    throw new UpdateSignatureError('"stagingPercentage" must be a number');
  }
  const files = manifest.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new UpdateSignatureError('"files" must list at least one file');
  }
  return {
    v: 1,
    version,
    releaseName: optionalString(manifest, 'releaseName'),
    releaseNotes: normalizeReleaseNotes(manifest.releaseNotes),
    minimumSystemVersion: optionalString(manifest, 'minimumSystemVersion'),
    stagingPercentage: typeof staging === 'number' ? staging : null,
    path: optionalString(manifest, 'path'),
    sha512: optionalString(manifest, 'sha512'),
    files: files.map((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new UpdateSignatureError('"files" entry is malformed');
      }
      const file = entry as Manifest;
      const url = optionalString(file, 'url');
      const sha512 = optionalString(file, 'sha512');
      if (!url || !sha512) throw new UpdateSignatureError('every file needs "url" and "sha512"');
      const size = file.size;
      if (size !== undefined && size !== null && typeof size !== 'number') {
        throw new UpdateSignatureError('file "size" must be a number');
      }
      return {
        url,
        sha512,
        size: typeof size === 'number' ? size : null,
        isAdminRightsRequired: file.isAdminRightsRequired === true,
      };
    }),
  };
}

function publicKeyFromBase64(spkiBase64: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(spkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update signing key must be Ed25519');
  return key;
}

/** Stable identifier for a public key: the first 16 hex digits of SHA-256 over its SPKI DER. */
export function updateSigningKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** SPKI DER, base64 — the form embedded in the app as a trusted key. */
export function exportUpdateSigningPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function signUpdateManifest(
  manifest: Manifest,
  privateKey: KeyObject
): UpdateManifestSignature {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Update signing key must be Ed25519');
  }
  const payloadJson = JSON.stringify(projectUpdateManifest(manifest));
  const payload = Buffer.from(payloadJson, 'utf8').toString('base64');
  return {
    keyId: updateSigningKeyId(createPublicKey(privateKey)),
    payload,
    signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  };
}

/**
 * Verify a fetched update manifest against the app's trusted keys. Throws unless the manifest
 * carries a valid signature from one of them and every acted-on field matches the signed values.
 */
export function verifyUpdateManifest(
  manifest: Manifest,
  trustedPublicKeys: readonly string[]
): SignedUpdatePayload {
  const raw = manifest[UPDATE_SIGNATURE_FIELD];
  if (typeof raw !== 'object' || raw === null) {
    throw new UpdateSignatureError('the manifest is not signed');
  }
  const { keyId, payload, signature } = raw as Record<string, unknown>;
  if (typeof keyId !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') {
    throw new UpdateSignatureError('the signature block is malformed');
  }
  const publicKey = trustedPublicKeys
    .map(publicKeyFromBase64)
    .find((key) => updateSigningKeyId(key) === keyId);
  if (!publicKey) throw new UpdateSignatureError(`signing key ${keyId} is not trusted`);
  if (!verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'))) {
    throw new UpdateSignatureError('the signature is invalid');
  }
  const signedJson = Buffer.from(payload, 'base64').toString('utf8');
  if (JSON.stringify(projectUpdateManifest(manifest)) !== signedJson) {
    throw new UpdateSignatureError('the manifest does not match its signed contents');
  }
  return JSON.parse(signedJson) as SignedUpdatePayload;
}
