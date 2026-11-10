import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import {
  applyClaudeAccountEnv,
  type ClaudeAccountLaunch,
  type ClaudeAccountLaunchResolver,
  type ClaudeAccountSessionEnv,
} from '../api/node/launch';
import {
  MAX_CLAUDE_ACCOUNT_LABEL_LENGTH,
  PRIMARY_CLAUDE_ACCOUNT_ID,
  type ClaudeAccount,
  type ClaudeAccountsError,
  type ClaudeAccountsState,
} from '../api/types';
import {
  CLAUDE_ACCOUNT_ID_PATTERN,
  type ClaudeAccountsSettings,
  type StoredClaudeAccount,
  type StoredClaudeIdentity,
} from '../contributions/settings';
import {
  prepareAccountFolder,
  primaryClaudeDir,
  removeAccountFolder,
  type AccountFolderFs,
} from './account-folder';
import type { ClaudeCliRunner } from './claude-cli';
import { parseClaudeAuthStatus, type ClaudeIdentity } from './identity';

const PRIMARY_LABEL = 'Primary';

/** Where the registry is kept: the `claudeAccounts` app setting. */
export type ClaudeAccountsSettingsStore = {
  get(): Promise<ClaudeAccountsSettings>;
  update(value: ClaudeAccountsSettings): Promise<void>;
};

export type ClaudeAccountsServiceDeps = {
  settings: ClaudeAccountsSettingsStore;
  /** Holds one folder per extra account: `<userData>/claude-accounts`. */
  accountsRoot: string;
  homeDir: string;
  platform: NodeJS.Platform;
  runCli: ClaudeCliRunner;
  logger: Pick<Logger, 'warn'>;
  fs?: AccountFolderFs;
  newId?: () => string;
  now?: () => Date;
};

/**
 * The registry of Claude accounts and the folders behind the extra ones. It never opens a
 * sign-in file: signing in and out is the CLI's work, and identity is what the CLI reports.
 */
export class ClaudeAccountsService implements ClaudeAccountLaunchResolver {
  private readonly listeners = new Set<(state: ClaudeAccountsState) => void>();
  private readonly folderLocks = new Map<string, Promise<unknown>>();
  private mutations: Promise<unknown> = Promise.resolve();
  /** Accounts on their way out: still in the registry, no longer usable. */
  private readonly removing = new Set<string>();

  constructor(private readonly deps: ClaudeAccountsServiceDeps) {}

  async list(): Promise<ClaudeAccountsState> {
    return this.toState(await this.deps.settings.get());
  }

  /** Listens for every change to the accounts or the default. Returns the unsubscribe. */
  onChanged(listener: (state: ClaudeAccountsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(label: string): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    const cleanLabel = validLabel(label);
    if (!cleanLabel.success) return cleanLabel;
    const id = (this.deps.newId ?? randomUUID)();
    const configDir = this.configDir(id);
    try {
      await this.inFolder(id, () => prepareAccountFolder(configDir, this.folderEnvironment()));
    } catch (error) {
      await this.inFolder(id, () =>
        removeAccountFolder(configDir, this.deps.accountsRoot, this.deps.fs)
      ).catch(() => undefined);
      return err({ type: 'folder-failed', message: errorMessage(error) });
    }
    const stored: StoredClaudeAccount = {
      id,
      label: cleanLabel.data,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    await this.mutate((settings) => ({ ...settings, accounts: [...settings.accounts, stored] }));
    return ok(this.toAccount(stored));
  }

  async rename(id: string, label: string): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    if (id === PRIMARY_CLAUDE_ACCOUNT_ID) return err({ type: 'primary-immutable' });
    const cleanLabel = validLabel(label);
    if (!cleanLabel.success) return cleanLabel;
    return this.updateStored(id, (account) => ({ ...account, label: cleanLabel.data }));
  }

  /**
   * Signs the account out and deletes its folder. Conversations that used it fall back to the
   * default account the next time they start. The shared setup in `~/.claude` is untouched.
   */
  async remove(id: string): Promise<Result<void, ClaudeAccountsError>> {
    if (id === PRIMARY_CLAUDE_ACCOUNT_ID) return err({ type: 'primary-immutable' });
    const settings = await this.deps.settings.get();
    if (!settings.accounts.some((account) => account.id === id) || this.removing.has(id)) {
      return err({ type: 'not-found', accountId: id });
    }
    const configDir = this.configDir(id);
    // From here on nothing new starts under this account: a conversation that used it resolves
    // to the default account, and a launch already past that point fails in `prepare`.
    this.removing.add(id);
    try {
      // Best effort: an account that cannot be signed out is still removed.
      await this.deps
        .runCli(['auth', 'logout'], { accountId: id, configDir })
        .catch(() => undefined);
      try {
        await this.inFolder(id, () =>
          removeAccountFolder(configDir, this.deps.accountsRoot, this.deps.fs)
        );
      } catch (error) {
        return err({ type: 'folder-failed', message: errorMessage(error) });
      }
      await this.mutate((current) => ({
        ...current,
        accounts: current.accounts.filter((account) => account.id !== id),
        defaultAccountId:
          current.defaultAccountId === id ? PRIMARY_CLAUDE_ACCOUNT_ID : current.defaultAccountId,
      }));
      return ok();
    } finally {
      this.removing.delete(id);
    }
  }

  async setDefault(id: string): Promise<Result<void, ClaudeAccountsError>> {
    const settings = await this.deps.settings.get();
    if (!isKnown(settings, id)) return err({ type: 'not-found', accountId: id });
    await this.mutate((current) => ({ ...current, defaultAccountId: id }));
    return ok();
  }

  /** Asks the CLI who the account is signed in as, and remembers the answer. */
  async refreshIdentity(id: string): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    const settings = await this.deps.settings.get();
    if (!isKnown(settings, id)) return err({ type: 'not-found', accountId: id });
    const launch =
      id === PRIMARY_CLAUDE_ACCOUNT_ID ? null : { accountId: id, configDir: this.configDir(id) };

    let identity: ClaudeIdentity | null;
    try {
      const result = await this.deps.runCli(['auth', 'status', '--json'], launch);
      identity = parseClaudeAuthStatus(result.stdout, result.exitCode);
    } catch (error) {
      return err({ type: 'cli-unavailable', message: errorMessage(error) });
    }
    if (!identity) {
      return err({ type: 'cli-unavailable', message: 'Claude Code did not report its sign-in' });
    }

    const found = identity;
    if (id === PRIMARY_CLAUDE_ACCOUNT_ID) {
      const state = await this.mutate((current) => ({
        ...current,
        primaryIdentity: storedIdentity(found),
      }));
      return ok(state.accounts[0]!);
    }
    return this.updateStored(id, (account) => ({
      id: account.id,
      label: account.label,
      createdAt: account.createdAt,
      ...storedIdentity(found),
    }));
  }

  /**
   * The account id a new Claude conversation is created with: the explicit choice when it
   * names an account that exists, otherwise the current default.
   */
  async resolveAccountId(explicit?: string): Promise<string> {
    const settings = this.usable(await this.deps.settings.get());
    return explicit && isKnown(settings, explicit) ? explicit : effectiveDefault(settings);
  }

  async resolve(accountId: string | undefined): Promise<ClaudeAccountLaunch | null> {
    // No recorded account: created on the primary sign-in, and it stays there.
    if (accountId === undefined) return null;
    const id = await this.resolveAccountId(accountId);
    if (id === PRIMARY_CLAUDE_ACCOUNT_ID) return null;
    return { accountId: id, configDir: this.configDir(id) };
  }

  async prepare(launch: ClaudeAccountLaunch): Promise<void> {
    let result;
    try {
      result = await this.inFolder(launch.accountId, async () => {
        // Checked with the folder held: a removal that got here first has already deleted it,
        // and preparing now would bring an unregistered folder back.
        const settings = this.usable(await this.deps.settings.get());
        if (!settings.accounts.some((account) => account.id === launch.accountId)) {
          throw new Error('the account was removed');
        }
        return prepareAccountFolder(this.configDir(launch.accountId), this.folderEnvironment());
      });
    } catch (error) {
      throw new Error(`Could not prepare the Claude account folder: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (result.skipped.length > 0) {
      this.deps.logger.warn('ClaudeAccounts: some of the shared setup was not brought over', {
        accountId: launch.accountId,
        skipped: result.skipped,
      });
    }
  }

  /** Every account with the directory its sign-in lives in, primary first, as `list` orders. */
  async signInFolders(): Promise<Array<{ id: string; configDir: string }>> {
    const settings = await this.deps.settings.get();
    return [
      { id: PRIMARY_CLAUDE_ACCOUNT_ID, configDir: primaryClaudeDir(this.deps.homeDir) },
      ...settings.accounts.map((account) => ({
        id: account.id,
        configDir: this.configDir(account.id),
      })),
    ];
  }

  /**
   * The variables a sign-in terminal for this account runs with, with the account's folder
   * brought up to date first. Null for the primary account, whose sign-in runs as it always
   * has. Throws when the account does not exist.
   */
  async loginEnv(accountId: string): Promise<ClaudeAccountSessionEnv | null> {
    const settings = this.usable(await this.deps.settings.get());
    if (!isKnown(settings, accountId)) throw new Error('That Claude account no longer exists');
    if (accountId === PRIMARY_CLAUDE_ACCOUNT_ID) return null;
    const launch = { accountId, configDir: this.configDir(accountId) };
    await this.prepare(launch);
    return applyClaudeAccountEnv({}, launch);
  }

  /** The registry without accounts that are being removed. */
  private usable(settings: ClaudeAccountsSettings): ClaudeAccountsSettings {
    if (this.removing.size === 0) return settings;
    return {
      ...settings,
      accounts: settings.accounts.filter((account) => !this.removing.has(account.id)),
    };
  }

  private configDir(id: string): string {
    // Ids become folder names; anything else could name a path outside the accounts folder.
    if (id === PRIMARY_CLAUDE_ACCOUNT_ID || !CLAUDE_ACCOUNT_ID_PATTERN.test(id)) {
      throw new Error('Not an extra Claude account id');
    }
    return path.join(this.deps.accountsRoot, id);
  }

  private folderEnvironment() {
    return { homeDir: this.deps.homeDir, platform: this.deps.platform, fs: this.deps.fs };
  }

  private async updateStored(
    id: string,
    update: (account: StoredClaudeAccount) => StoredClaudeAccount
  ): Promise<Result<ClaudeAccount, ClaudeAccountsError>> {
    let updated: StoredClaudeAccount | undefined;
    await this.mutate((settings) => ({
      ...settings,
      accounts: settings.accounts.map((account) => {
        if (account.id !== id) return account;
        updated = update(account);
        return updated;
      }),
    }));
    return updated ? ok(this.toAccount(updated)) : err({ type: 'not-found', accountId: id });
  }

  /** One settings change at a time, each applied to the latest stored value. */
  private mutate(
    change: (settings: ClaudeAccountsSettings) => ClaudeAccountsSettings
  ): Promise<ClaudeAccountsState> {
    const run = this.mutations.then(async () => {
      const next = change(await this.deps.settings.get());
      await this.deps.settings.update(next);
      const state = this.toState(next);
      for (const listener of this.listeners) listener(state);
      return state;
    });
    this.mutations = run.catch(() => undefined);
    return run;
  }

  /** Preparing and removing one account's folder never overlap. */
  private inFolder<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.folderLocks.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run
      .catch(() => undefined)
      .then(() => {
        if (this.folderLocks.get(id) === tail) this.folderLocks.delete(id);
      });
    this.folderLocks.set(id, tail);
    return run;
  }

  private toState(settings: ClaudeAccountsSettings): ClaudeAccountsState {
    const primary: ClaudeAccount = {
      id: PRIMARY_CLAUDE_ACCOUNT_ID,
      label: PRIMARY_LABEL,
      kind: 'primary',
      ...shownIdentity(settings.primaryIdentity),
    };
    return {
      accounts: [primary, ...settings.accounts.map((account) => this.toAccount(account))],
      defaultAccountId: effectiveDefault(settings),
    };
  }

  private toAccount(stored: StoredClaudeAccount): ClaudeAccount {
    return {
      id: stored.id,
      label: stored.label,
      kind: 'extra',
      configDir: this.configDir(stored.id),
      ...shownIdentity(stored),
      createdAt: stored.createdAt,
    };
  }
}

export function createClaudeAccountsService(
  deps: ClaudeAccountsServiceDeps
): ClaudeAccountsService {
  return new ClaudeAccountsService(deps);
}

function isKnown(settings: ClaudeAccountsSettings, id: string): boolean {
  return id === PRIMARY_CLAUDE_ACCOUNT_ID || settings.accounts.some((account) => account.id === id);
}

/** A default that names a removed account means the primary account. */
function effectiveDefault(settings: ClaudeAccountsSettings): string {
  return isKnown(settings, settings.defaultAccountId)
    ? settings.defaultAccountId
    : PRIMARY_CLAUDE_ACCOUNT_ID;
}

function storedIdentity(identity: ClaudeIdentity): StoredClaudeIdentity {
  return {
    loggedIn: identity.loggedIn,
    ...(identity.email && { email: identity.email }),
    ...(identity.plan && { plan: identity.plan }),
  };
}

function shownIdentity(
  identity: StoredClaudeIdentity
): Pick<ClaudeAccount, 'email' | 'plan' | 'loggedIn'> {
  return {
    ...(identity.email && { email: identity.email }),
    ...(identity.plan && { plan: identity.plan }),
    loggedIn: identity.loggedIn === true,
  };
}

function validLabel(label: string): Result<string, ClaudeAccountsError> {
  const clean = label.trim();
  if (!clean) return err({ type: 'invalid-label', message: 'Give the account a name' });
  if (clean.length > MAX_CLAUDE_ACCOUNT_LABEL_LENGTH) {
    return err({
      type: 'invalid-label',
      message: `Use at most ${MAX_CLAUDE_ACCOUNT_LABEL_LENGTH} characters`,
    });
  }
  return ok(clean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
