import { createHash } from 'node:crypto';
import type nodeFs from 'node:fs/promises';
import path from 'node:path';
import {
  accountSettingsFrom,
  canonical,
  parseObject,
  primarySettingsFrom,
  sameSettings,
} from './account-settings';

/**
 * Keeps the parts of the setup that cannot be linked in step between the primary setup and an
 * extra account's folder: `CLAUDE.md`, `settings.json`, and the `mcpServers` of `.claude.json`.
 *
 * The setup is shared, so the sync goes both ways and never loses an edit. A small state file
 * in the account folder records, per item, what each side held when they were last in step:
 *
 * - only the primary side changed: it is brought into the account;
 * - only the account side changed (an edit made in a session under that account): it is
 *   written back to the primary setup, so every account sees it;
 * - both changed: both are left exactly as they are, and the item is reported.
 *
 * A side that disappears is never taken as an instruction to delete the other: a missing
 * account copy is restored from the primary side. The one deletion is an account copy that is
 * still what the last sync left there, after its primary file was deleted.
 */

export type SyncFs = Pick<
  typeof nodeFs,
  'lstat' | 'mkdir' | 'unlink' | 'rename' | 'readFile' | 'writeFile'
>;

export type SyncSkip = { name: string; reason: string };

/** Lives in the account folder as a real file and goes when the folder is removed. */
export const SYNC_STATE_FILE = '.maestro-sync.json';

const CONFLICT_REASON =
  'changed both in this account and in the primary setup since they last matched; ' +
  'both were left as they are';

type ItemState = { primary: string | null; account: string | null };
type SyncState = Record<string, ItemState>;

/** One synced thing, seen as a text on each side (null when that side has none). */
type SyncItem = {
  name: string;
  readPrimary(): Promise<string | null>;
  readAccount(): Promise<string | null>;
  /** What the account holds for this primary content, given what it holds now. */
  toAccount(primary: string | null, account: string | null): string | null;
  /** What the account held under the one-way copy this sync replaced. */
  legacyToAccount(primary: string | null, account: string | null): string | null;
  /** What the primary side holds after this account edit; undefined when it cannot be merged. */
  toPrimary(account: string, primary: string | null): string | null | undefined;
  same(left: string | null, right: string | null): boolean;
  /** Identity of a side's content for the state file. */
  fingerprint(text: string | null): string | null;
  writePrimary(text: string): Promise<void>;
  /** Null removes the account's copy. */
  writeAccount(text: string | null): Promise<void>;
};

export type SharedSetupPaths = {
  accountDir: string;
  primaryDir: string;
  /** The primary `.claude.json`, which sits beside the primary directory, not in it. */
  primaryStateFile: string;
};

/** Syncs every item. A failure or conflict in one is reported and does not stop the others. */
export async function syncSharedSetup(fs: SyncFs, paths: SharedSetupPaths): Promise<SyncSkip[]> {
  const skipped: SyncSkip[] = [];
  const stateFile = path.join(paths.accountDir, SYNC_STATE_FILE);
  const state = await readState(fs, stateFile);
  const next: SyncState = { ...state };

  for (const item of syncItems(fs, paths)) {
    try {
      const result = await syncItem(item, state[item.name]);
      if (result === 'conflict') skipped.push({ name: item.name, reason: CONFLICT_REASON });
      else next[item.name] = result;
    } catch (error) {
      skipped.push({ name: item.name, reason: errorMessage(error) });
    }
  }

  if (canonical(next) !== canonical(state)) {
    try {
      await writeState(fs, stateFile, next);
    } catch (error) {
      skipped.push({ name: SYNC_STATE_FILE, reason: errorMessage(error) });
    }
  }
  return skipped;
}

async function syncItem(
  item: SyncItem,
  previous: ItemState | undefined
): Promise<ItemState | 'conflict'> {
  const primary = await item.readPrimary();
  const account = await item.readAccount();
  const seen: ItemState = {
    primary: item.fingerprint(primary),
    account: item.fingerprint(account),
  };
  if (previous && previous.primary === seen.primary && previous.account === seen.account) {
    return previous;
  }

  const direction = syncDirection(item, previous, seen, primary, account);
  if (direction === 'conflict') return 'conflict';

  let finalPrimary = primary;
  if (direction === 'to-primary' && account !== null) {
    const wanted = item.toPrimary(account, primary);
    if (wanted === undefined) {
      throw new Error('one side is not a JSON object, so the edit was not carried over');
    }
    if (wanted !== null && !item.same(wanted, primary)) {
      await item.writePrimary(wanted);
      finalPrimary = wanted;
    }
  }

  // Both directions end with the account holding what it should for the primary content.
  let finalAccount = account;
  const wanted = item.toAccount(finalPrimary, account);
  // An account's own edit is never answered by deleting its file.
  const keepsOwnFile = direction === 'to-primary' && wanted === null;
  if (!keepsOwnFile && !item.same(wanted, account)) {
    await item.writeAccount(wanted);
    finalAccount = wanted;
  }
  return { primary: item.fingerprint(finalPrimary), account: item.fingerprint(finalAccount) };
}

function syncDirection(
  item: SyncItem,
  previous: ItemState | undefined,
  seen: ItemState,
  primary: string | null,
  account: string | null
): 'to-account' | 'to-primary' | 'conflict' {
  // A missing account copy is filled in, never taken as a deletion to pass on.
  if (account === null) return 'to-account';
  const settled = () => item.same(item.toAccount(primary, account), account);

  if (!previous) {
    // Nothing recorded yet. An edit made here while the primary side has nothing loses
    // nothing by being shared; a copy the old one-way sync would have left is in step.
    if (primary === null) return 'to-primary';
    if (settled() || item.same(item.legacyToAccount(primary, account), account)) {
      return 'to-account';
    }
    return 'conflict';
  }

  const primaryChanged = previous.primary !== seen.primary;
  const accountChanged = previous.account !== seen.account;
  if (accountChanged && !primaryChanged) return 'to-primary';
  if (primaryChanged && !accountChanged) return 'to-account';
  // Both changed: fine when they already agree, otherwise nobody's edit is overwritten.
  return settled() ? 'to-account' : 'conflict';
}

function syncItems(fs: SyncFs, paths: SharedSetupPaths): SyncItem[] {
  const textFingerprint = (text: string | null) => (text === null ? null : sha256(text));
  const fileItem = (
    name: string
  ): Pick<
    SyncItem,
    'name' | 'readPrimary' | 'readAccount' | 'fingerprint' | 'writePrimary' | 'writeAccount'
  > => {
    const primaryFile = path.join(paths.primaryDir, name);
    const accountFile = path.join(paths.accountDir, name);
    let primaryRead: string | null = null;
    let accountRead: string | null = null;
    return {
      name,
      readPrimary: async () => (primaryRead = await readText(fs, primaryFile)),
      readAccount: async () => {
        // A link here could lead back into the primary setup; it is detached, not followed.
        if ((await lstatOrNull(fs, accountFile))?.isSymbolicLink()) await fs.unlink(accountFile);
        return (accountRead = await readText(fs, accountFile));
      },
      fingerprint: textFingerprint,
      writePrimary: async (text) => {
        await fs.mkdir(paths.primaryDir, { recursive: true });
        await replaceFile(fs, primaryFile, text, primaryRead);
        primaryRead = text;
      },
      writeAccount: async (text) => {
        if (text === null) await removeUnchanged(fs, accountFile, accountRead);
        else await replaceFile(fs, accountFile, text, accountRead);
        accountRead = text;
      },
    };
  };
  const identity = (primary: string | null) => primary;

  return [
    {
      ...fileItem('CLAUDE.md'),
      toAccount: identity,
      legacyToAccount: identity,
      toPrimary: (account) => account,
      same: (left, right) => left === right,
    },
    {
      ...fileItem('settings.json'),
      toAccount: accountSettingsFrom,
      legacyToAccount: (primary, account) =>
        accountSettingsFrom(primary, account, { keepSignIn: true }),
      toPrimary: primarySettingsFrom,
      same: sameSettings,
    },
    mcpServersItem(fs, paths),
  ];
}

/**
 * The `mcpServers` key of `.claude.json` on each side, as JSON text (null when the key is
 * absent). Only that key is ever written; the rest of each file belongs to the CLI.
 */
function mcpServersItem(fs: SyncFs, paths: SharedSetupPaths): SyncItem {
  const KEY = 'mcpServers';
  const accountFile = path.join(paths.accountDir, '.claude.json');
  const side = (file: string, label: string) => {
    let read: string | null = null;
    return {
      read: async (): Promise<string | null> => {
        read = await readText(fs, file);
        if (read === null) return null;
        const state = parseObject(read);
        // Unreadable right now (the CLI may be mid-write): try again next time.
        if (!state) throw new Error(`the ${label} .claude.json could not be read`);
        return state[KEY] === undefined ? null : JSON.stringify(state[KEY]);
      },
      write: async (text: string | null): Promise<void> => {
        const state = read === null ? {} : parseObject(read);
        if (!state) throw new Error(`the ${label} .claude.json could not be read`);
        const next = { ...state };
        if (text === null) delete next[KEY];
        else next[KEY] = JSON.parse(text);
        const written = `${JSON.stringify(next, null, 2)}\n`;
        await replaceFile(fs, file, written, read);
        read = written;
      },
    };
  };
  const primary = side(paths.primaryStateFile, 'primary');
  const account = side(accountFile, "account's");
  const same = (left: string | null, right: string | null) =>
    left === right ||
    (left !== null &&
      right !== null &&
      canonical(JSON.parse(left)) === canonical(JSON.parse(right)));
  const identity = (text: string | null) => text;

  return {
    name: KEY,
    readPrimary: primary.read,
    readAccount: account.read,
    toAccount: identity,
    legacyToAccount: identity,
    toPrimary: (text) => text,
    same,
    fingerprint: (text) => (text === null ? null : sha256(canonical(JSON.parse(text)))),
    writePrimary: (text) => primary.write(text),
    writeAccount: (text) => account.write(text),
  };
}

/**
 * Replaces a file's content through a temporary file beside it and a rename, so a failure
 * leaves the file as it was. Refuses when the file is a link (the write would replace the
 * link, not what it points at) and when the file no longer holds `expected`: another program
 * wrote it since it was read, and that write must not be lost. The next sync tries again.
 */
async function replaceFile(
  fs: SyncFs,
  file: string,
  text: string,
  expected: string | null
): Promise<void> {
  if ((await lstatOrNull(fs, file))?.isSymbolicLink()) {
    throw new Error('the file is a link, which is not written through');
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  try {
    if ((await readText(fs, file)) !== expected) {
      throw new Error('the file changed while it was being synced');
    }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeUnchanged(fs: SyncFs, file: string, expected: string | null): Promise<void> {
  if ((await readText(fs, file)) !== expected) {
    throw new Error('the file changed while it was being synced');
  }
  await fs.unlink(file).catch((error: unknown) => {
    if (!isCode(error, 'ENOENT')) throw error;
  });
}

async function readState(fs: SyncFs, file: string): Promise<SyncState> {
  if ((await lstatOrNull(fs, file))?.isSymbolicLink()) {
    await fs.unlink(file);
    return {};
  }
  const items = parseObject((await readText(fs, file)) ?? '')?.items;
  const state: SyncState = {};
  for (const [name, entry] of Object.entries(parseObjectValue(items))) {
    const record = parseObjectValue(entry);
    const primary = record.primary;
    const account = record.account;
    if (isFingerprint(primary) && isFingerprint(account)) state[name] = { primary, account };
  }
  return state;
}

async function writeState(fs: SyncFs, file: string, state: SyncState): Promise<void> {
  const text = `${JSON.stringify({ version: 1, items: state }, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function parseObjectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isFingerprint(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readText(fs: SyncFs, file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return null;
    throw error;
  }
}

async function lstatOrNull(fs: SyncFs, entry: string) {
  try {
    return await fs.lstat(entry);
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return null;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
