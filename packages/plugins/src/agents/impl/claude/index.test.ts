import { describe, expect, it } from 'vitest';
import { provider } from './index';

describe('claude provider session MCP', () => {
  const launch = {
    configPath: '/home/me/.config/Chorus/chorus/agent-mcp/c1.json',
    servers: [
      {
        name: 'chorus-browser',
        url: 'http://127.0.0.1:4100/mcp',
        tokenEnvVar: 'CHORUS_BROWSER_MCP_TOKEN',
      },
    ],
  };

  it('points --mcp-config at the session file in one argument', () => {
    expect(provider.behavior.mcp!.sessionArgs!(launch)).toEqual([
      `--mcp-config=${launch.configPath}`,
    ]);
  });

  it('keeps the prompt as its own positional argument after the flag', () => {
    const extraArgs = provider.behavior.mcp!.sessionArgs!(launch);
    const command = provider.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      initialPrompt: 'check the app',
      sessionId: '6f1c2f0e-7d1b-4c43-9a55-2d4b0e1f3a10',
      providerSessionId: undefined,
      isResuming: false,
      model: '',
      extraArgs,
    });
    const flagIndex = command.args.indexOf(`--mcp-config=${launch.configPath}`);
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(command.args.at(-1)).toBe('check the app');
    expect(flagIndex).toBeLessThan(command.args.length - 1);
  });
});
