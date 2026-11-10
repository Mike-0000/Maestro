import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIMARY_CLAUDE_ACCOUNT_ID, type ClaudeAccountsState } from '../api/types';
import {
  DEFAULT_CLAUDE_ACCOUNTS_SETTINGS,
  type ClaudeAccountsSettings,
} from '../contributions/settings';
import { ClaudeAccountsService } from './claude-accounts-service';
import type { ClaudeCliRunner } from './claude-cli';

let root: string;
let home: string;
let accountsRoot: string;
let stored: ClaudeAccountsSettings;

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false
  );

function createService(runCli: ClaudeCliRunner = vi.fn(async () => ({ exitCode: 1, stdout: '' }))) {
  let nextId = 1;
  const service = new ClaudeAccountsService({
    settings: {
      get: async () => stored,
      update: async (value) => {
        stored = value;
      },
    },
    accountsRoot,
    homeDir: home,
    platform: process.platform,
    runCli,
    logger: { warn: vi.fn() },
    newId: () => `account-${nextId++}`,
    now: () => new Date('2026-11-10T12:00:00.000Z'),
  });
  return { service, runCli };
}

async function created(service: ClaudeAccountsService, label: string) {
  const result = await service.create(label);
  if (!result.success) throw new Error(`create failed: ${result.error.type}`);
  return result.data;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claude-accounts-service-'));
  home = path.join(root, 'home');
  accountsRoot = path.join(root, 'data', 'claude-accounts');
  stored = DEFAULT_CLAUDE_ACCOUNTS_SETTINGS;
  await mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'skills', 'SKILL.md'), 'shared');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ClaudeAccountsService', () => {
  it('starts with only the primary account, which is the default', async () => {
    const { service } = createService();

    expect(await service.list()).toEqual({
      accounts: [{ id: 'primary', label: 'Primary', kind: 'primary', loggedIn: false }],
      defaultAccountId: 'primary',
    });
    expect(stored.accounts).toEqual([]);
  });

  it('creates an account with a prepared folder and stores no path or credential', async () => {
    const { service } = createService();

    const account = await created(service, '  Work  ');

    expect(account).toEqual({
      id: 'account-1',
      label: 'Work',
      kind: 'extra',
      configDir: path.join(accountsRoot, 'account-1'),
      loggedIn: false,
      createdAt: '2026-11-10T12:00:00.000Z',
    });
    expect((await lstat(path.join(accountsRoot, 'account-1', 'skills'))).isSymbolicLink()).toBe(
      true
    );
    expect(stored.accounts).toEqual([
      { id: 'account-1', label: 'Work', createdAt: '2026-11-10T12:00:00.000Z' },
    ]);
    expect((await service.list()).accounts.map((entry) => entry.id)).toEqual([
      'primary',
      'account-1',
    ]);
  });

  it('rejects an empty or overlong label', async () => {
    const { service } = createService();

    expect(await service.create('   ')).toMatchObject({ error: { type: 'invalid-label' } });
    expect(await service.create('x'.repeat(61))).toMatchObject({
      error: { type: 'invalid-label' },
    });
    expect(stored.accounts).toEqual([]);
  });

  it('renames an extra account and refuses to rename the primary one', async () => {
    const { service } = createService();
    const account = await created(service, 'Work');

    expect(await service.rename(account.id, 'Client')).toMatchObject({
      success: true,
      data: { id: account.id, label: 'Client' },
    });
    expect(await service.rename(PRIMARY_CLAUDE_ACCOUNT_ID, 'Mine')).toMatchObject({
      error: { type: 'primary-immutable' },
    });
    expect(await service.rename('missing', 'X')).toMatchObject({ error: { type: 'not-found' } });
  });

  it('sets the default to any existing account and nothing else', async () => {
    const { service } = createService();
    const account = await created(service, 'Work');

    expect((await service.setDefault(account.id)).success).toBe(true);
    expect((await service.list()).defaultAccountId).toBe(account.id);
    expect(await service.setDefault('missing')).toMatchObject({ error: { type: 'not-found' } });
    expect((await service.setDefault(PRIMARY_CLAUDE_ACCOUNT_ID)).success).toBe(true);
    expect((await service.list()).defaultAccountId).toBe('primary');
  });

  it('removes an account: signs it out, deletes its folder, keeps the shared setup', async () => {
    const { service, runCli } = createService();
    const account = await created(service, 'Work');
    await service.setDefault(account.id);

    expect((await service.remove(account.id)).success).toBe(true);

    expect(runCli).toHaveBeenCalledWith(['auth', 'logout'], {
      accountId: account.id,
      configDir: path.join(accountsRoot, account.id),
    });
    expect(await exists(path.join(accountsRoot, account.id))).toBe(false);
    expect(await readFile(path.join(home, '.claude', 'skills', 'SKILL.md'), 'utf8')).toBe('shared');
    expect(await service.list()).toMatchObject({
      accounts: [{ id: 'primary' }],
      defaultAccountId: 'primary',
    });
  });

  it('still removes an account whose sign-out fails', async () => {
    const { service } = createService(
      vi.fn(async () => {
        throw new Error('no cli');
      })
    );
    const account = await created(service, 'Work');

    expect((await service.remove(account.id)).success).toBe(true);
    expect(stored.accounts).toEqual([]);
  });

  it('stops new launches under an account as soon as its removal begins', async () => {
    let finishLogout = () => {};
    const logout = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    const { service } = createService(
      vi.fn(async (args: string[]) => {
        if (args[1] === 'logout') await logout;
        return { exitCode: 0, stdout: '' };
      })
    );
    const work = await created(service, 'Work');
    const client = await created(service, 'Client');
    await service.setDefault(client.id);
    const launch = await service.resolve(work.id);

    const removal = service.remove(work.id);
    await vi.waitFor(() => expect(stored.accounts).toHaveLength(2));

    // Signing out is still running: a new start already goes to the default account,
    expect(await service.resolve(work.id)).toMatchObject({ accountId: client.id });
    // one that had already resolved fails cleanly instead of running in a folder on its way out,
    await expect(service.prepare(launch!)).rejects.toThrow(/account was removed/);
    await expect(service.loginEnv(work.id)).rejects.toThrow(/no longer exists/);
    // and a second removal does not run alongside the first.
    expect(await service.remove(work.id)).toMatchObject({ error: { type: 'not-found' } });

    finishLogout();
    expect((await removal).success).toBe(true);
    expect(await exists(path.join(accountsRoot, work.id))).toBe(false);
  });

  it('does not bring back the folder of an account removed while a launch was waiting', async () => {
    const { service } = createService();
    const work = await created(service, 'Work');
    const launch = await service.resolve(work.id);

    // The launch asks for the folder just after removal took it.
    const removal = service.remove(work.id);
    const preparation = service.prepare(launch!);

    await expect(preparation).rejects.toThrow(/account was removed/);
    expect((await removal).success).toBe(true);
    expect(await exists(path.join(accountsRoot, work.id))).toBe(false);
    expect(stored.accounts).toEqual([]);
  });

  it('refuses to remove the primary account or one that does not exist', async () => {
    const { service, runCli } = createService();

    expect(await service.remove(PRIMARY_CLAUDE_ACCOUNT_ID)).toMatchObject({
      error: { type: 'primary-immutable' },
    });
    expect(await service.remove('../../home')).toMatchObject({ error: { type: 'not-found' } });
    expect(runCli).not.toHaveBeenCalled();
    expect(await exists(path.join(home, '.claude', 'skills', 'SKILL.md'))).toBe(true);
  });

  it('stores what the CLI reports about a signed-in account', async () => {
    const runCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'second@example.com',
        subscriptionType: 'max',
      }),
    }));
    const { service } = createService(runCli);
    const account = await created(service, 'Work');

    const refreshed = await service.refreshIdentity(account.id);

    expect(runCli).toHaveBeenCalledWith(['auth', 'status', '--json'], {
      accountId: account.id,
      configDir: path.join(accountsRoot, account.id),
    });
    expect(refreshed).toMatchObject({
      success: true,
      data: { email: 'second@example.com', plan: 'max', loggedIn: true },
    });
    expect(stored.accounts[0]).toEqual({
      id: account.id,
      label: 'Work',
      createdAt: '2026-11-10T12:00:00.000Z',
      loggedIn: true,
      email: 'second@example.com',
      plan: 'max',
    });
  });

  it('reads a signed-out report, which the CLI prints with exit code 1', async () => {
    const answers = [
      { exitCode: 0, stdout: '{"loggedIn":true,"email":"second@example.com"}' },
      { exitCode: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' },
    ];
    const { service } = createService(vi.fn(async () => answers.shift()!));
    const account = await created(service, 'Work');
    await service.refreshIdentity(account.id);

    const refreshed = await service.refreshIdentity(account.id);

    expect(refreshed).toMatchObject({ success: true, data: { loggedIn: false } });
    expect(refreshed.success && refreshed.data).not.toHaveProperty('email');
  });

  it('refreshes the primary account without an account folder', async () => {
    const runCli = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"loggedIn":true,"email":"me@example.com"}',
    }));
    const { service } = createService(runCli);

    const refreshed = await service.refreshIdentity(PRIMARY_CLAUDE_ACCOUNT_ID);

    expect(runCli).toHaveBeenCalledWith(['auth', 'status', '--json'], null);
    expect(refreshed).toMatchObject({
      success: true,
      data: { id: 'primary', kind: 'primary', email: 'me@example.com', loggedIn: true },
    });
    expect(stored.accounts).toEqual([]);
  });

  it('keeps the stored identity when the CLI cannot be run or answers nonsense', async () => {
    const { service } = createService(
      vi
        .fn<ClaudeCliRunner>()
        .mockResolvedValueOnce({ exitCode: 0, stdout: '{"loggedIn":true,"email":"a@b.c"}' })
        .mockRejectedValueOnce(new Error('not installed'))
        .mockResolvedValueOnce({ exitCode: 2, stdout: 'usage: claude' })
    );
    const account = await created(service, 'Work');
    await service.refreshIdentity(account.id);

    expect(await service.refreshIdentity(account.id)).toMatchObject({
      error: { type: 'cli-unavailable', message: 'not installed' },
    });
    expect(await service.refreshIdentity(account.id)).toMatchObject({
      error: { type: 'cli-unavailable' },
    });
    expect(stored.accounts[0]).toMatchObject({ loggedIn: true, email: 'a@b.c' });
  });

  it('tells listeners the whole state after every change', async () => {
    const { service } = createService();
    const states: ClaudeAccountsState[] = [];
    const stop = service.onChanged((state) => states.push(state));

    const account = await created(service, 'Work');
    await service.setDefault(account.id);
    stop();
    await service.rename(account.id, 'Client');

    expect(states.map((state) => [state.accounts.length, state.defaultAccountId])).toEqual([
      [2, 'primary'],
      [2, account.id],
    ]);
  });

  describe('which account a conversation uses', () => {
    it('records the explicit choice when it exists, otherwise the default', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');
      const client = await created(service, 'Client');
      await service.setDefault(work.id);

      expect(await service.resolveAccountId()).toBe(work.id);
      expect(await service.resolveAccountId(client.id)).toBe(client.id);
      expect(await service.resolveAccountId(PRIMARY_CLAUDE_ACCOUNT_ID)).toBe('primary');
      expect(await service.resolveAccountId('removed')).toBe(work.id);
    });

    it('launches the primary account with nothing, an extra one from its folder', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');

      expect(await service.resolve(PRIMARY_CLAUDE_ACCOUNT_ID)).toBeNull();
      expect(await service.resolve(work.id)).toEqual({
        accountId: work.id,
        configDir: path.join(accountsRoot, work.id),
      });
    });

    it('keeps a conversation with no recorded account on the primary one', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');
      await service.setDefault(work.id);

      // Created before accounts existed, on the primary sign-in: the default does not move it.
      expect(await service.resolve(undefined)).toBeNull();
      // A new conversation is still recorded with the default.
      expect(await service.resolveAccountId()).toBe(work.id);
    });

    it('falls back to the default account once its own account is removed', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');
      const client = await created(service, 'Client');
      await service.setDefault(client.id);

      await service.remove(work.id);
      expect(await service.resolve(work.id)).toMatchObject({ accountId: client.id });

      // Removing the default account too leaves the primary one.
      await service.remove(client.id);
      expect(await service.resolve(work.id)).toBeNull();
    });

    it('prepares the folder again before a launch', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');
      await mkdir(path.join(home, '.claude', 'agents'));

      const launch = await service.resolve(work.id);
      await service.prepare(launch!);

      expect((await lstat(path.join(launch!.configDir, 'agents'))).isSymbolicLink()).toBe(true);
    });
  });

  describe('the sign-in terminal', () => {
    it('runs under the account folder, without credentials that would outrank it', async () => {
      const { service } = createService();
      const work = await created(service, 'Work');

      expect(await service.loginEnv(work.id)).toEqual({
        env: { CLAUDE_CONFIG_DIR: path.join(accountsRoot, work.id) },
        unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      });
    });

    it('is the ordinary sign-in for the primary account, and refuses a removed one', async () => {
      const { service } = createService();

      expect(await service.loginEnv(PRIMARY_CLAUDE_ACCOUNT_ID)).toBeNull();
      await expect(service.loginEnv('removed')).rejects.toThrow(/no longer exists/);
    });
  });
});
