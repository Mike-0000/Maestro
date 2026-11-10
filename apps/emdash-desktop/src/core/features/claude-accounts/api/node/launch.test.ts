import { describe, expect, it } from 'vitest';
import { applyClaudeAccountEnv } from './launch';

describe('applyClaudeAccountEnv', () => {
  const launch = { accountId: 'account-1', configDir: '/data/claude-accounts/account-1' };

  it('points the session at the account and drops credentials that outrank its sign-in', () => {
    expect(
      applyClaudeAccountEnv(
        {
          ANTHROPIC_API_KEY: 'sk-key',
          ANTHROPIC_AUTH_TOKEN: 'token',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
          CLAUDE_CONFIG_DIR: '/user/config',
          ANTHROPIC_BASE_URL: 'https://proxy',
        },
        launch
      )
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy',
        CLAUDE_CONFIG_DIR: '/data/claude-accounts/account-1',
      },
      unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('matches names whatever their case, as Windows does', () => {
    const { env } = applyClaudeAccountEnv(
      { anthropic_api_key: 'sk-key', Claude_Config_Dir: 'C:\\other' },
      launch
    );

    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/data/claude-accounts/account-1' });
  });
});
