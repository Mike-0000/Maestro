import { makeStdinHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { accountSettingsFrom, primarySettingsFrom, sameSettings } from './account-settings';

const managedHook = (event: string) => ({
  hooks: [{ type: 'command', command: makeStdinHookCommand(event) }],
});
const userHook = { hooks: [{ type: 'command', command: 'echo done' }] };
const json = (value: unknown) => JSON.stringify(value);
const parsed = (text: string | null | undefined) => JSON.parse(text ?? 'null');

describe('accountSettingsFrom', () => {
  it('is the primary file byte for byte when there is nothing to strip or keep', () => {
    const primaryText = '{ "model":"opus",\n\t"env": {"FOO": "1"} }';

    expect(accountSettingsFrom(primaryText, null)).toBe(primaryText);
    expect(accountSettingsFrom(primaryText, '{"model":"old"}')).toBe(primaryText);
    expect(accountSettingsFrom(null, null)).toBeNull();
  });

  it('never carries the ways the primary file signs a session in', () => {
    const account = accountSettingsFrom(
      json({
        model: 'opus',
        apiKeyHelper: '/bin/print-key',
        forceLoginMethod: 'console',
        forceLoginOrgUUID: 'org-1',
        env: {
          ANTHROPIC_API_KEY: 'sk-primary',
          anthropic_auth_token: 'token',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
          ANTHROPIC_BASE_URL: 'https://proxy',
        },
      }),
      null
    );

    expect(parsed(account)).toEqual({
      model: 'opus',
      env: { ANTHROPIC_BASE_URL: 'https://proxy' },
    });
    expect(account).not.toContain('sk-primary');
  });

  it('drops an env block that held nothing but a sign-in', () => {
    expect(
      parsed(accountSettingsFrom(json({ env: { ANTHROPIC_API_KEY: 'sk' }, model: 'opus' }), null))
    ).toEqual({ model: 'opus' });
  });

  it('is the primary file byte for byte when it already has the hooks', () => {
    const primaryText = json({ hooks: { Stop: [userHook, managedHook('stop')] } });
    const accountText = json({ hooks: { Stop: [managedHook('stop'), userHook] } });

    expect(accountSettingsFrom(primaryText, accountText)).toBe(primaryText);
  });

  it("keeps the app's hooks from the account and none of its other hooks", () => {
    const merged = accountSettingsFrom(
      json({ hooks: { Stop: [userHook] } }),
      json({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'stale' }] }, managedHook('stop')] },
      })
    );

    expect(parsed(merged).hooks.Stop).toEqual([userHook, managedHook('stop')]);
  });

  it('keeps only the hooks when the primary file is gone', () => {
    const kept = accountSettingsFrom(
      null,
      json({ model: 'opus', hooks: { Stop: [managedHook('stop')] } })
    );

    expect(parsed(kept)).toEqual({ hooks: { Stop: [managedHook('stop')] } });
    expect(accountSettingsFrom(null, '{"model":"opus"}')).toBeNull();
  });

  it('passes a primary file it cannot parse through as it is', () => {
    expect(accountSettingsFrom('not json', '{"hooks":{}}')).toBe('not json');
  });
});

describe('primarySettingsFrom', () => {
  const primaryText = json({
    model: 'opus',
    apiKeyHelper: '/bin/print-key',
    env: { ANTHROPIC_API_KEY: 'sk-primary', ANTHROPIC_BASE_URL: 'https://proxy' },
  });

  it("puts the primary file's own sign-in settings back around the account's edit", () => {
    const account = accountSettingsFrom(primaryText, null);
    const edited = json({ ...parsed(account), model: 'sonnet', permissions: { allow: ['Bash'] } });

    expect(parsed(primarySettingsFrom(edited, primaryText))).toEqual({
      model: 'sonnet',
      permissions: { allow: ['Bash'] },
      apiKeyHelper: '/bin/print-key',
      env: { ANTHROPIC_BASE_URL: 'https://proxy', ANTHROPIC_API_KEY: 'sk-primary' },
    });
  });

  it('is the primary text byte for byte when the account says the same thing', () => {
    const account = accountSettingsFrom(primaryText, null);
    const reformatted = JSON.stringify(parsed(account), null, 4);

    expect(primarySettingsFrom(reformatted, primaryText)).toBe(primaryText);
  });

  it('never carries a sign-in from the account into the shared setup', () => {
    const next = primarySettingsFrom(
      json({
        model: 'opus',
        apiKeyHelper: '/account/helper',
        env: { ANTHROPIC_API_KEY: 'sk-acct' },
      }),
      json({ model: 'opus' })
    );

    expect(next).toBe(json({ model: 'opus' }));
  });

  it('takes the hooks as the account has them, without duplicating entries', () => {
    const primary = json({ hooks: { Stop: [userHook] } });
    const account = json({ hooks: { Stop: [userHook, managedHook('stop')] } });

    const pushed = primarySettingsFrom(account, primary);
    expect(parsed(pushed).hooks.Stop).toEqual([userHook, managedHook('stop')]);
    // The account copy for the new primary file is what the account already holds.
    expect(sameSettings(accountSettingsFrom(pushed ?? null, account), account)).toBe(true);
    expect(primarySettingsFrom(account, pushed ?? null)).toBe(pushed);
  });

  it('refuses when either side is not a JSON object', () => {
    expect(primarySettingsFrom('not json', primaryText)).toBeUndefined();
    expect(primarySettingsFrom('{"model":"sonnet"}', '[]')).toBeUndefined();
  });
});

describe('sameSettings', () => {
  it('ignores formatting and key order, and nothing else', () => {
    expect(sameSettings('{"a":1,"b":{"c":2,"d":3}}', '{\n "b": {"d":3,"c":2}, "a": 1 }')).toBe(
      true
    );
    expect(sameSettings('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameSettings(null, '{}')).toBe(false);
    expect(sameSettings('not json', 'not json')).toBe(true);
  });
});
