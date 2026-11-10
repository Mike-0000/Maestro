import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeStdinHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAccountFolder, removeAccountFolder, seedAccountState } from './account-folder';

let root: string;
let home: string;
let primary: string;
let accountsRoot: string;
let account: string;

const prepare = () => prepareAccountFolder(account, { homeDir: home, platform: process.platform });
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false
  );
const managedHook = (event: string) => ({
  hooks: [{ type: 'command', command: makeStdinHookCommand(event) }],
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claude-accounts-'));
  home = path.join(root, 'home');
  primary = path.join(home, '.claude');
  accountsRoot = path.join(root, 'data', 'claude-accounts');
  account = path.join(accountsRoot, 'account-1');
  await mkdir(path.join(primary, 'skills', 'review'), { recursive: true });
  await mkdir(path.join(primary, 'projects'), { recursive: true });
  await writeFile(path.join(primary, 'skills', 'review', 'SKILL.md'), 'review skill');
  await writeFile(path.join(primary, 'settings.json'), '{"model":"opus"}');
  await writeFile(path.join(primary, 'CLAUDE.md'), 'be brief');
  await writeFile(path.join(primary, '.credentials.json'), '{"secret":"primary-token"}');
  await writeFile(path.join(primary, 'history.jsonl'), 'history');
  await writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'primary@example.com' },
      userID: 'primary-user',
      cachedStatsigGates: { a: true },
      s1mAccessCache: { b: true },
      projects: { '/repo': { hasTrustDialogAccepted: true } },
      mcpServers: { files: { command: 'files-mcp' } },
    })
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('prepareAccountFolder', () => {
  it('links every directory of the primary setup and nothing else', async () => {
    const result = await prepare();

    expect(result.skipped).toEqual([]);
    for (const name of ['skills', 'projects']) {
      const link = path.join(account, name);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(path.join(primary, name));
    }
    // A file written through the link lands in the shared setup.
    await writeFile(path.join(account, 'projects', 'session.jsonl'), 'session');
    expect(await readFile(path.join(primary, 'projects', 'session.jsonl'), 'utf8')).toBe('session');
    expect(await exists(path.join(account, 'history.jsonl'))).toBe(false);
  });

  it('never links or copies the sign-in', async () => {
    await prepare();

    expect(await exists(path.join(account, '.credentials.json'))).toBe(false);
  });

  it('copies settings.json and CLAUDE.md one way, and removes a copy whose source is gone', async () => {
    await prepare();
    expect(await readFile(path.join(account, 'settings.json'), 'utf8')).toBe('{"model":"opus"}');
    expect(await readFile(path.join(account, 'CLAUDE.md'), 'utf8')).toBe('be brief');

    await writeFile(path.join(primary, 'settings.json'), '{"model":"sonnet"}');
    await rm(path.join(primary, 'CLAUDE.md'));
    await prepare();

    expect(await readFile(path.join(account, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
    expect(await exists(path.join(account, 'CLAUDE.md'))).toBe(false);
    // The copy is real: the primary files were not touched by the sync.
    expect((await lstat(path.join(account, 'settings.json'))).isSymbolicLink()).toBe(false);
  });

  it('writes nothing on a second run with nothing changed', async () => {
    await prepare();
    const files = ['settings.json', 'CLAUDE.md', '.claude.json', '.maestro-sync.json'].map((name) =>
      path.join(account, name)
    );
    const before = await Promise.all(files.map(async (file) => (await stat(file)).mtimeMs));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await prepare();

    expect(result.skipped).toEqual([]);
    expect(await Promise.all(files.map(async (file) => (await stat(file)).mtimeMs))).toEqual(
      before
    );
    expect(await readlink(path.join(account, 'skills'))).toBe(path.join(primary, 'skills'));
  });

  it('links a directory that appears in the primary setup later, and drops a stale link', async () => {
    await prepare();
    await mkdir(path.join(primary, 'agents'));
    await rm(path.join(primary, 'projects'), { recursive: true });

    await prepare();

    expect(await readlink(path.join(account, 'agents'))).toBe(path.join(primary, 'agents'));
    expect(await exists(path.join(account, 'projects'))).toBe(false);
  });

  it('moves a directory the CLI created under the account into the shared setup', async () => {
    await prepare();
    await mkdir(path.join(account, 'todos'));
    await writeFile(path.join(account, 'todos', 'list.json'), '[]');

    await prepare();

    expect(await readFile(path.join(primary, 'todos', 'list.json'), 'utf8')).toBe('[]');
    expect(await readlink(path.join(account, 'todos'))).toBe(path.join(primary, 'todos'));
  });

  it('leaves a folder with its own content alone when the primary setup has one too', async () => {
    await mkdir(path.join(account, 'skills'), { recursive: true });
    await writeFile(path.join(account, 'skills', 'own.md'), 'own');

    const result = await prepare();

    expect(result.skipped.map((entry) => entry.name)).toEqual(['skills']);
    expect(await readFile(path.join(account, 'skills', 'own.md'), 'utf8')).toBe('own');
  });

  it('seeds .claude.json once, without the primary sign-in', async () => {
    await prepare();

    const state = await readJson(path.join(account, '.claude.json'));
    expect(state).toEqual({
      hasCompletedOnboarding: true,
      projects: { '/repo': { hasTrustDialogAccepted: true } },
      mcpServers: { files: { command: 'files-mcp' } },
    });

    // The CLI signs the account in; a later run keeps what it wrote.
    await writeFile(
      path.join(account, '.claude.json'),
      JSON.stringify({ ...state, oauthAccount: { emailAddress: 'second@example.com' } })
    );
    await prepare();
    expect((await readJson(path.join(account, '.claude.json'))).oauthAccount).toEqual({
      emailAddress: 'second@example.com',
    });
  });

  it('keeps mcpServers in step with the primary file and nothing else', async () => {
    await prepare();
    const accountFile = path.join(account, '.claude.json');
    await writeFile(
      accountFile,
      JSON.stringify({ ...(await readJson(accountFile)), numStartups: 7 })
    );
    const primaryState = await readJson(path.join(home, '.claude.json'));

    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        ...primaryState,
        mcpServers: { web: { url: 'https://mcp' } },
        theme: 'dark',
      })
    );
    await prepare();
    expect(await readJson(accountFile)).toMatchObject({
      mcpServers: { web: { url: 'https://mcp' } },
      numStartups: 7,
    });
    expect(await readJson(accountFile)).not.toHaveProperty('theme');

    const { mcpServers: _removed, ...withoutServers } = primaryState;
    await writeFile(path.join(home, '.claude.json'), JSON.stringify(withoutServers));
    await prepare();
    expect(await readJson(accountFile)).not.toHaveProperty('mcpServers');
  });

  it("keeps workspace trust written into the account's file across later syncs", async () => {
    await prepare();
    const accountFile = path.join(account, '.claude.json');
    const state = await readJson(accountFile);
    // What the trust writer does when a session starts under this account.
    await writeFile(
      accountFile,
      JSON.stringify({
        ...state,
        projects: { ...state.projects, '/worktree': { hasTrustDialogAccepted: true } },
      })
    );
    // The user adds an MCP server through the app, which writes the primary file.
    await writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({
        ...(await readJson(path.join(home, '.claude.json'))),
        mcpServers: { web: { url: 'https://mcp' } },
      })
    );

    await prepare();

    const synced = await readJson(accountFile);
    expect(synced.mcpServers).toEqual({ web: { url: 'https://mcp' } });
    expect(synced.projects).toEqual({
      '/repo': { hasTrustDialogAccepted: true },
      '/worktree': { hasTrustDialogAccepted: true },
    });
    // Trust for the account never reached the primary file.
    expect((await readJson(path.join(home, '.claude.json'))).projects).not.toHaveProperty(
      '/worktree'
    );
  });

  it('leaves the account file alone while the primary file cannot be read', async () => {
    await prepare();
    const before = await readFile(path.join(account, '.claude.json'), 'utf8');
    await writeFile(path.join(home, '.claude.json'), '{"mcpServers":');

    await prepare();

    expect(await readFile(path.join(account, '.claude.json'), 'utf8')).toBe(before);
  });

  it('works when Claude Code has never run on this computer', async () => {
    await rm(home, { recursive: true });

    const result = await prepare();

    expect(result.skipped).toEqual([]);
    expect(await readJson(path.join(account, '.claude.json'))).toEqual({});
  });

  it('keeps hooks the app installed into the account across the next sync', async () => {
    await prepare();
    const accountSettings = path.join(account, 'settings.json');
    // What the hook installer does on the first terminal session under this account.
    await writeFile(
      accountSettings,
      JSON.stringify({ model: 'opus', hooks: { Stop: [managedHook('stop')] } })
    );

    await prepare();
    expect((await readJson(accountSettings)).hooks.Stop).toEqual([managedHook('stop')]);

    // A change in the primary file still comes through, with the hooks kept.
    await writeFile(path.join(primary, 'settings.json'), '{"model":"sonnet"}');
    await prepare();
    expect(await readJson(accountSettings)).toEqual({
      model: 'sonnet',
      hooks: { Stop: [managedHook('stop')] },
    });
  });
});

describe('seedAccountState', () => {
  it('drops the sign-in, stored keys and entitlement caches', () => {
    expect(
      seedAccountState({
        oauthAccount: {},
        primaryApiKey: 'sk-secret',
        customApiKeyResponses: {},
        cachedChangelog: 'x',
        passesEligibilityCache: {},
        hasCompletedOnboarding: true,
        mcpServers: {},
      })
    ).toEqual({ hasCompletedOnboarding: true, mcpServers: {} });
  });
});

describe('removeAccountFolder', () => {
  it('deletes the folder and leaves everything it linked to in place', async () => {
    await prepare();
    await writeFile(path.join(account, '.credentials.json'), '{"secret":"second-token"}');
    await mkdir(path.join(account, 'own', 'nested'), { recursive: true });
    await writeFile(path.join(account, 'own', 'nested', 'file'), 'x');

    await removeAccountFolder(account, accountsRoot);

    expect(await exists(account)).toBe(false);
    expect(await readFile(path.join(primary, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe(
      'review skill'
    );
    expect(await exists(path.join(primary, 'projects'))).toBe(true);
    expect(await readFile(path.join(primary, 'settings.json'), 'utf8')).toBe('{"model":"opus"}');
    expect(await readFile(path.join(primary, '.credentials.json'), 'utf8')).toContain(
      'primary-token'
    );
  });

  it('does not follow a link nested inside a real directory, or a link to a file', async () => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await mkdir(path.join(account, 'deep'), { recursive: true });
    await symlink(outside, path.join(account, 'deep', 'link'), 'dir');
    await symlink(path.join(outside, 'keep.txt'), path.join(account, 'file-link'));

    await removeAccountFolder(account, accountsRoot);

    expect(await exists(account)).toBe(false);
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('unlinks an account folder that is itself a link', async () => {
    await mkdir(accountsRoot, { recursive: true });
    await symlink(primary, account, 'dir');

    await removeAccountFolder(account, accountsRoot);

    expect(await exists(account)).toBe(false);
    expect(await exists(path.join(primary, 'skills', 'review', 'SKILL.md'))).toBe(true);
  });

  it('refuses anything that is not a folder inside the accounts directory', async () => {
    await expect(removeAccountFolder(primary, accountsRoot)).rejects.toThrow(/outside/);
    await expect(removeAccountFolder(accountsRoot, accountsRoot)).rejects.toThrow(/outside/);
    await expect(
      removeAccountFolder(path.join(accountsRoot, '..', '..', 'home'), accountsRoot)
    ).rejects.toThrow(/outside/);
    expect(await exists(path.join(primary, 'skills', 'review', 'SKILL.md'))).toBe(true);
  });

  it('is fine with a folder that is already gone', async () => {
    await expect(removeAccountFolder(account, accountsRoot)).resolves.toBeUndefined();
  });
});
