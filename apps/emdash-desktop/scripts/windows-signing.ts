import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import type { WindowsConfiguration } from 'electron-builder';

/** Overrides the local signing file; `off` builds unsigned even when the file exists. */
export const WINDOWS_SIGNING_ENV = 'CHORUS_WIN_SIGN_CERT_SHA1';
const SHA1_THUMBPRINT = /^[0-9A-F]{40}$/;

type SigningEnvironment = Partial<Record<string, string>>;
type SigntoolOptions = NonNullable<WindowsConfiguration['signtoolOptions']>;

/** Machine-local file written by `setup-windows-local-signing.ps1`; never committed. */
export function windowsSigningFile(environment: SigningEnvironment = process.env): string | null {
  return environment.LOCALAPPDATA
    ? win32.join(environment.LOCALAPPDATA, 'Chorus', 'Signing', 'windows-signing.json')
    : null;
}

/**
 * Resolve the Authenticode identity for Windows builds. The certificate stays in the Windows
 * certificate store (non-exportable key) and signtool finds it by thumbprint, so no key material
 * or password passes through the build. Without an identity, builds stay unsigned as before.
 */
export function resolveWindowsSigntoolOptions(
  environment: SigningEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): SigntoolOptions | undefined {
  if (platform !== 'win32') return undefined;
  const thumbprint =
    environment[WINDOWS_SIGNING_ENV]?.trim() || readThumbprint(environment, readFile);
  if (!thumbprint || thumbprint.toLowerCase() === 'off') return undefined;
  const certificateSha1 = thumbprint.replace(/\s/g, '').toUpperCase();
  if (!SHA1_THUMBPRINT.test(certificateSha1)) {
    throw new Error(`Windows signing thumbprint is not a SHA-1 hex digest: ${thumbprint}`);
  }
  return { certificateSha1, signingHashAlgorithms: ['sha256'] };
}

function readThumbprint(
  environment: SigningEnvironment,
  readFile: (path: string) => string
): string | undefined {
  const file = windowsSigningFile(environment);
  if (!file) return undefined;
  let raw: string;
  try {
    raw = readFile(file);
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw.replace(/^﻿/, '')) as { certificateSha1?: unknown };
  if (typeof parsed.certificateSha1 !== 'string') {
    throw new Error(`${file} must contain a string "certificateSha1"`);
  }
  return parsed.certificateSha1;
}
