// Creates the Ed25519 key that signs Maestro update manifests. The private key stays on this
// machine (never commit it); the printed public key goes into UPDATE_SIGNING_PUBLIC_KEYS in
// src/core/primitives/app-identity/api/app-identity.ts. See docs/chorus/auto-update.md.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { UPDATE_SIGNING_PUBLIC_KEYS } from '../../src/core/primitives/app-identity/api/app-identity.ts';
import {
  exportUpdateSigningPublicKey,
  updateSigningKeyId,
} from '../../src/main/host/updates/update-manifest-signature.ts';
import { fail, info, step } from './lib/log.ts';
import { defaultSigningKeyFile, loadSigningKey, SIGNING_KEY_ENV } from './lib/maestro-update.ts';

const keyFile = defaultSigningKeyFile();
if (!keyFile) fail(`Set ${SIGNING_KEY_ENV} or LOCALAPPDATA to choose where the key is stored`);

if (existsSync(keyFile)) {
  step('Signing key already exists; reusing it');
} else {
  step('Generating a new Ed25519 update signing key');
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyFile), { recursive: true });
  // `wx` never overwrites: replacing the key would strand every installed copy on the old one.
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    flag: 'wx',
    mode: 0o600,
  });
}

const publicKey = createPublicKey(loadSigningKey(keyFile));
const encoded = exportUpdateSigningPublicKey(publicKey);
info(`Private key: ${keyFile}`);
info('Back this file up somewhere private (e.g. a password manager). Losing it means installed');
info('copies can no longer update until they are reinstalled from a build trusting a new key.');
info(`Key id:      ${updateSigningKeyId(publicKey)}`);
info(`Public key:  ${encoded}`);
if (UPDATE_SIGNING_PUBLIC_KEYS.includes(encoded)) {
  info('This build already trusts the key.');
} else {
  info('Add it to app-identity.ts:');
  info(`  export const UPDATE_SIGNING_PUBLIC_KEYS: readonly string[] = ['${encoded}'];`);
}
