import nodeFs, {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeStdinHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAccountFolder, removeAccountFolder } from './account-folder';
import { SYNC_STATE_FILE, syncSharedSetup, type SyncFs } from './shared-setup-sync';

let root: string;
let home: string;
let primary: string;
let accountsRoot: string;
let first: string;
let second: string;

const prepare = (accountDir: string) =>
  prepareAccountFolder(accountDir, { homeDir: home, platform: process.platform });
const read = (file: string) => readFile(file, 'utf8').catch(() => null);
const readJson = async (file: string) => JSON.parse((await read(file)) ?? 'null');
const skippedNames = (result: { skipped: Array<{ name: string }> }) =>
  result.skipped.map((entry) => entry.name);
const primaryState = () => path.join(home, '.claude.json');
const managedHook = (event: string) => ({
  hooks: [{ type: 'command', command: makeStdinHookCommand(event) }],
});
const withSignIn = {
  model: 'opus',
  apiKeyHelper: '/bin/print-key',
  env: { ANTHROPIC_API_KEY: 'sk-primary', ANTHROPIC_BASE_URL: 'https://proxy' },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'claude-sync-'));
  home = path.join(root, 'home');
  primary = path.join(home, '.claude');
  accountsRoot = path.join(root, 'data', 'claude-accounts');
  first = path.join(accountsRoot, 'first');
  second = path.join(accountsRoot, 'second');
  await mkdir(primary, { recursive: true });
  await writeFile(path.join(primary, 'settings.json'), JSON.stringify(withSignIn));
  await writeFile(path.join(primary, 'CLAUDE.md'), 'be brief');
  await writeFile(
    primaryState(),
    JSON.stringify({ numStartups: 3, mcpServers: { files: { command: 'files-mcp' } } })
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sign-in settings', () => {
  it("never reach an account's settings.json, and the primary file is left alone", async () => {
    const before = await read(path.join(primary, 'settings.json'));

    await prepare(first);

    const copy = await read(path.join(first, 'settings.json'));
    expect(JSON.parse(copy ?? '')).toEqual({
      model: 'opus',
      env: { ANTHROPIC_BASE_URL: 'https://proxy' },
    });
    expect(copy).not.toContain('sk-primary');
    expect(await read(path.join(primary, 'settings.json'))).toBe(before);
  });

  it('are stripped from a copy an earlier version made', async () => {
    await mkdir(first, { recursive: true });
    await writeFile(path.join(first, 'settings.json'), JSON.stringify(withSignIn));

    const result = await prepare(first);

    expect(result.skipped).toEqual([]);
    expect(await read(path.join(first, 'settings.json'))).not.toContain('sk-primary');
  });
});

describe('edits made in an account', () => {
  it('reach the primary setup and, through it, every other account', async () => {
    await prepare(first);
    await prepare(second);
    // In a session under the first account: /memory, /model, and `claude mcp add -s user`.
    await writeFile(path.join(first, 'CLAUDE.md'), 'be brief\nand kind');
    await writeFile(
      path.join(first, 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_BASE_URL: 'https://proxy' } })
    );
    await writeFile(
      path.join(first, '.claude.json'),
      JSON.stringify({
        ...(await readJson(path.join(first, '.claude.json'))),
        mcpServers: { files: { command: 'files-mcp' }, web: { url: 'https://mcp' } },
      })
    );

    expect((await prepare(first)).skipped).toEqual([]);
    expect((await prepare(second)).skipped).toEqual([]);

    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('be brief\nand kind');
    expect(await read(path.join(second, 'CLAUDE.md'))).toBe('be brief\nand kind');
    // The primary file keeps its own sign-in settings around the edit.
    expect(await readJson(path.join(primary, 'settings.json'))).toEqual({
      model: 'sonnet',
      env: { ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'sk-primary' },
      apiKeyHelper: '/bin/print-key',
    });
    expect(await readJson(path.join(second, 'settings.json'))).toEqual({
      model: 'sonnet',
      env: { ANTHROPIC_BASE_URL: 'https://proxy' },
    });
    expect((await readJson(primaryState())).mcpServers).toHaveProperty('web');
    expect((await readJson(primaryState())).numStartups).toBe(3);
    expect((await readJson(path.join(second, '.claude.json'))).mcpServers).toHaveProperty('web');
  });

  it('settle: further preparations of either account write nothing', async () => {
    await prepare(first);
    await prepare(second);
    await writeFile(path.join(first, 'CLAUDE.md'), 'edited in first');
    await prepare(first);
    await prepare(second);
    const snapshot = async () =>
      Promise.all(
        [primary, first, second].flatMap((dir) =>
          ['CLAUDE.md', 'settings.json', SYNC_STATE_FILE].map(async (name) => {
            const info = await lstat(path.join(dir, name)).catch(() => null);
            return `${name}:${info?.mtimeMs ?? 'none'}:${await read(path.join(dir, name))}`;
          })
        )
      );
    const before = await snapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (const account of [first, second, first, second]) {
      expect((await prepare(account)).skipped).toEqual([]);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('creates a CLAUDE.md in the primary setup when it had none', async () => {
    await rm(path.join(primary, 'CLAUDE.md'));
    await prepare(first);
    await writeFile(path.join(first, 'CLAUDE.md'), 'written with /memory');

    await prepare(first);
    // And a later preparation does not take it away again.
    await prepare(first);

    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('written with /memory');
    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('written with /memory');
  });

  it('are not reformatted into the primary file when they say the same thing', async () => {
    await prepare(first);
    const before = await read(path.join(primary, 'settings.json'));
    // The CLI rewrote its copy with different spacing and key order.
    await writeFile(
      path.join(first, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy' }, model: 'opus' }, null, 4)
    );

    expect((await prepare(first)).skipped).toEqual([]);

    expect(await read(path.join(primary, 'settings.json'))).toBe(before);
  });

  it("push the app's hooks to the primary file once, without duplicates", async () => {
    await prepare(first);
    await prepare(second);
    // The hook installer, on the first terminal session under each account.
    for (const account of [first, second]) {
      const settings = await readJson(path.join(account, 'settings.json'));
      await writeFile(
        path.join(account, 'settings.json'),
        JSON.stringify({ ...settings, hooks: { Stop: [managedHook('stop')] } })
      );
    }

    for (const account of [first, second, first, second]) {
      expect((await prepare(account)).skipped).toEqual([]);
    }

    for (const dir of [primary, first, second]) {
      expect((await readJson(path.join(dir, 'settings.json'))).hooks.Stop).toEqual([
        managedHook('stop'),
      ]);
    }
    expect((await readJson(path.join(primary, 'settings.json'))).apiKeyHelper).toBe(
      '/bin/print-key'
    );
  });
});

describe('edits on both sides', () => {
  it('are both left exactly as they are, and reported', async () => {
    await prepare(first);
    await writeFile(path.join(first, 'CLAUDE.md'), 'account edit');
    await writeFile(path.join(primary, 'CLAUDE.md'), 'primary edit');
    await writeFile(path.join(first, 'settings.json'), '{"model":"haiku"}');
    await writeFile(path.join(primary, 'settings.json'), '{"model":"sonnet"}');

    const result = await prepare(first);

    expect(skippedNames(result)).toEqual(['CLAUDE.md', 'settings.json']);
    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('account edit');
    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('primary edit');
    expect(await read(path.join(first, 'settings.json'))).toBe('{"model":"haiku"}');
    expect(await read(path.join(primary, 'settings.json'))).toBe('{"model":"sonnet"}');
    // Still reported, still untouched, the next time.
    expect(skippedNames(await prepare(first))).toEqual(['CLAUDE.md', 'settings.json']);
    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('account edit');
  });

  it('are in step again once the two agree', async () => {
    await prepare(first);
    await writeFile(path.join(first, 'CLAUDE.md'), 'account edit');
    await writeFile(path.join(primary, 'CLAUDE.md'), 'primary edit');
    await prepare(first);

    await writeFile(path.join(primary, 'CLAUDE.md'), 'account edit');

    expect((await prepare(first)).skipped).toEqual([]);
  });

  it('includes an account file of unknown origin found before any sync was recorded', async () => {
    await mkdir(first, { recursive: true });
    await writeFile(path.join(first, 'CLAUDE.md'), 'someone wrote this here');

    const result = await prepare(first);

    expect(skippedNames(result)).toEqual(['CLAUDE.md']);
    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('someone wrote this here');
    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('be brief');
  });
});

describe('what the sync never does', () => {
  it('never deletes a file it did not put there', async () => {
    await rm(path.join(primary, 'CLAUDE.md'));
    await mkdir(first, { recursive: true });
    await writeFile(path.join(first, 'CLAUDE.md'), 'only here');

    await prepare(first);

    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('only here');
    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('only here');
  });

  it('does not pass on a deletion made in the account; the copy is restored', async () => {
    await prepare(first);
    await rm(path.join(first, 'CLAUDE.md'));
    await rm(path.join(first, 'settings.json'));

    expect((await prepare(first)).skipped).toEqual([]);

    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('be brief');
    expect(await readJson(path.join(primary, 'settings.json'))).toEqual(withSignIn);
    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('be brief');
  });

  it('does not write a primary file through a link, or corrupt one it cannot merge', async () => {
    const dotfiles = path.join(root, 'dotfiles-CLAUDE.md');
    await writeFile(dotfiles, 'be brief');
    await rm(path.join(primary, 'CLAUDE.md'));
    await symlink(dotfiles, path.join(primary, 'CLAUDE.md'));
    await prepare(first);
    await writeFile(path.join(first, 'CLAUDE.md'), 'account edit');
    await writeFile(path.join(first, 'settings.json'), '{"model":"sonnet"}');
    await writeFile(path.join(primary, 'settings.json'), JSON.stringify(withSignIn));
    await writeFile(path.join(first, 'settings.json'), 'not json any more');

    const result = await prepare(first);

    expect(skippedNames(result)).toEqual(['CLAUDE.md', 'settings.json']);
    expect((await lstat(path.join(primary, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await read(dotfiles)).toBe('be brief');
    expect(await readJson(path.join(primary, 'settings.json'))).toEqual(withSignIn);
    expect(await read(path.join(first, 'CLAUDE.md'))).toBe('account edit');
    // Nothing half-written was left behind.
    expect((await readdir(primary)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not overwrite a .claude.json the CLI wrote while it was syncing', async () => {
    await prepare(first);
    const accountFile = path.join(first, '.claude.json');
    await writeFile(
      primaryState(),
      JSON.stringify({ mcpServers: { web: { url: 'https://mcp' } } })
    );
    // The CLI saves the account file between the sync's read and its write.
    const cliWrite = JSON.stringify({ oauthAccount: { emailAddress: 'second@example.com' } });
    const racingFs: SyncFs = {
      ...nodeFs,
      writeFile: (async (file: string, ...rest: [string, object]) => {
        if (String(file).startsWith(accountFile) && String(file).endsWith('.tmp')) {
          await writeFile(accountFile, cliWrite);
        }
        return writeFile(file, ...rest);
      }) as SyncFs['writeFile'],
    };

    const skipped = await syncSharedSetup(racingFs, {
      accountDir: first,
      primaryDir: primary,
      primaryStateFile: primaryState(),
    });

    expect(skipped.map((entry) => entry.name)).toEqual(['mcpServers']);
    expect(await read(accountFile)).toBe(cliWrite);
    expect((await readdir(first)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The next preparation, with nothing racing, brings the servers over.
    expect((await prepare(first)).skipped).toEqual([]);
    expect(await readJson(accountFile)).toEqual({
      oauthAccount: { emailAddress: 'second@example.com' },
      mcpServers: { web: { url: 'https://mcp' } },
    });
  });
});

describe('the sync state file', () => {
  it('is a real file in the account folder and goes with it', async () => {
    await prepare(first);

    const info = await lstat(path.join(first, SYNC_STATE_FILE));
    expect(info.isFile() && !info.isSymbolicLink()).toBe(true);
    expect(await read(path.join(first, SYNC_STATE_FILE))).not.toContain('sk-primary');

    await removeAccountFolder(first, accountsRoot);
    expect(await read(path.join(first, SYNC_STATE_FILE))).toBeNull();
    expect(await read(path.join(primary, 'CLAUDE.md'))).toBe('be brief');
  });
});
