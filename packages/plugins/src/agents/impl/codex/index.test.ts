import { describe, expect, it } from 'vitest';
import { provider } from './index';

const baseContext = {
  cli: 'codex',
  autoApprove: false,
  initialPrompt: undefined,
  sessionId: 'emdash-session-id',
  providerSessionId: undefined,
  isResuming: false,
  model: '',
};

describe('codex provider', () => {
  it('passes unquoted config overrides when auto-approve is enabled', () => {
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      autoApprove: true,
    });

    expect(command).toEqual({
      command: 'codex',
      args: [
        '-c',
        'approval_policy=never',
        '-c',
        'sandbox_mode=danger-full-access',
        '--dangerously-bypass-hook-trust',
      ],
      env: {},
    });
  });

  it('adds session MCP servers as unquoted config overrides with the token left in env', () => {
    const args = provider.behavior.mcp!.sessionArgs!({
      configPath: '/data/agent-mcp/c1.json',
      servers: [
        {
          name: 'chorus-browser',
          url: 'http://127.0.0.1:4100/mcp',
          tokenEnvVar: 'CHORUS_BROWSER_MCP_TOKEN',
        },
      ],
    });

    expect(args).toEqual([
      '-c',
      'mcp_servers.chorus-browser.url=http://127.0.0.1:4100/mcp',
      '-c',
      'mcp_servers.chorus-browser.bearer_token_env_var=CHORUS_BROWSER_MCP_TOKEN',
    ]);
    expect(args.join(' ')).not.toMatch(/chorus_bt_|Bearer/);
  });

  it('places session MCP overrides before the initial prompt', () => {
    const extraArgs = provider.behavior.mcp!.sessionArgs!({
      configPath: '/x.json',
      servers: [{ name: 'chorus-browser', url: 'http://127.0.0.1:1/mcp', tokenEnvVar: 'TOK' }],
    });
    const command = provider.behavior.prompt!.buildCommand({
      ...baseContext,
      initialPrompt: 'fix the login page',
      extraArgs,
    });
    expect(command.args.at(-1)).toBe('fix the login page');
    expect(command.args.slice(0, -1)).toEqual(expect.arrayContaining(extraArgs));
  });
});
