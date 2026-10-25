import { describe, expect, it } from 'vitest';
import { CLAUDE_SYSTEM_PROMPT_APPEND } from './delegation';
import { provider } from './index';

describe('claude provider delegation policy', () => {
  const context = {
    cli: 'claude',
    autoApprove: false,
    sessionId: '6f1c2f0e-7d1b-4c43-9a55-2d4b0e1f3a10',
    providerSessionId: undefined,
    model: '',
  };
  const policyArgs = ['--append-system-prompt', CLAUDE_SYSTEM_PROMPT_APPEND];

  it('is one line, so a Windows command line carries it whole', () => {
    expect(CLAUDE_SYSTEM_PROMPT_APPEND).not.toMatch(/[\r\n"]/);
  });

  it('covers sub-agents, being stuck, and Codex for computer use', () => {
    expect(CLAUDE_SYSTEM_PROMPT_APPEND).toMatch(/sub-agents/);
    expect(CLAUDE_SYSTEM_PROMPT_APPEND).toMatch(/vibe skill/);
    expect(CLAUDE_SYSTEM_PROMPT_APPEND).toMatch(/If you get stuck/);
    expect(CLAUDE_SYSTEM_PROMPT_APPEND).toMatch(/computer use.*provider codex/);
  });

  it('is appended to the system prompt ahead of the prompt on a fresh session', () => {
    const { args } = provider.behavior.prompt!.buildCommand({
      ...context,
      isResuming: false,
      initialPrompt: 'refactor the parser',
    });
    expect(args.slice(-3)).toEqual([...policyArgs, 'refactor the parser']);
  });

  it('is sent again on resume, since Claude does not persist it', () => {
    const { args } = provider.behavior.prompt!.buildCommand({ ...context, isResuming: true });
    expect(args).toEqual(['--resume', context.sessionId, ...policyArgs]);
  });

  it.each([['--append-system-prompt', 'mine'], ['--system-prompt-file=/tmp/prompt.md']])(
    "leaves the user's own system prompt alone (%s)",
    (...extraArgs) => {
      const { args } = provider.behavior.prompt!.buildCommand({
        ...context,
        isResuming: false,
        extraArgs,
      });
      expect(args).not.toContain(CLAUDE_SYSTEM_PROMPT_APPEND);
      expect(args.slice(-extraArgs.length)).toEqual(extraArgs);
    }
  );

  it('reaches ACP sessions through the adapter system prompt', () => {
    expect(provider.behavior.acp!.sessionMeta!()).toEqual({
      systemPrompt: { append: CLAUDE_SYSTEM_PROMPT_APPEND },
    });
  });
});

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
