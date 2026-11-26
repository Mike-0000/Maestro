import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureOwnerSetupToken,
  OWNER_SETUP_TOKEN_FILE,
  verifyOwnerSetupToken,
} from './owner-pairing-route';

// The routes themselves are exercised end to end in `owner-access.test.ts`.
describe('owner setup token', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-owner-setup-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a long random token readable by this user only', async () => {
    await ensureOwnerSetupToken(directory);
    const path = join(directory, OWNER_SETUP_TOKEN_FILE);
    const token = (await readFile(path, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect(await verifyOwnerSetupToken(directory, token)).toBe(true);
  });

  it('never replaces an existing token', async () => {
    await ensureOwnerSetupToken(directory);
    const path = join(directory, OWNER_SETUP_TOKEN_FILE);
    const first = await readFile(path, 'utf8');
    await ensureOwnerSetupToken(directory);
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('refuses a wrong, missing or empty token, and a file too short to be one', async () => {
    expect(await verifyOwnerSetupToken(directory, 'anything')).toBe(false);
    await ensureOwnerSetupToken(directory);
    const token = (await readFile(join(directory, OWNER_SETUP_TOKEN_FILE), 'utf8')).trim();
    expect(await verifyOwnerSetupToken(directory, undefined)).toBe(false);
    expect(await verifyOwnerSetupToken(directory, '')).toBe(false);
    expect(await verifyOwnerSetupToken(directory, `${token}x`)).toBe(false);
    expect(await verifyOwnerSetupToken(directory, token.slice(1))).toBe(false);

    await writeFile(join(directory, OWNER_SETUP_TOKEN_FILE), '\n');
    expect(await verifyOwnerSetupToken(directory, '')).toBe(false);
    await writeFile(join(directory, OWNER_SETUP_TOKEN_FILE), 'short');
    expect(await verifyOwnerSetupToken(directory, 'short')).toBe(false);
  });
});
