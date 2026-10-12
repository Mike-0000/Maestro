import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeBypassesPermissionsHere } from './wsl-auto-approve';

describe('claudeBypassesPermissionsHere', () => {
  let root: string;
  const settings = (value: unknown) =>
    writeFile(
      join(root, 'settings.json'),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  const ask = () => claudeBypassesPermissionsHere({ CLAUDE_CONFIG_DIR: root }, '/nowhere');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'emdash-claude-settings-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is true when the settings start Claude Code in bypass permissions mode', async () => {
    await settings({ theme: 'dark', permissions: { defaultMode: 'bypassPermissions' } });
    expect(await ask()).toBe(true);
  });

  it.each([
    ['another mode', { permissions: { defaultMode: 'acceptEdits' } }],
    ['no mode', { permissions: { allow: ['Bash(ls:*)'] } }],
    ['no permissions', { theme: 'dark' }],
    ['not an object', [1, 2]],
    ['not JSON', '{ nope'],
  ])('is false with %s', async (_name, value) => {
    await settings(value);
    expect(await ask()).toBe(false);
  });

  it('is false without a settings file', async () => {
    expect(await ask()).toBe(false);
    expect(await claudeBypassesPermissionsHere({}, join(root, 'no-home'))).toBe(false);
  });
});
