import { ok } from '@emdash/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import {
  TuiConversationProvider,
  type TuiConversationProviderDependencies,
  type TuiConversationProviderOptions,
} from './tui-conversation-provider';

const start = vi.hoisted(() => vi.fn());
const resume = vi.hoisted(() => vi.fn());

describe('TuiConversationProvider', () => {
  beforeEach(() => {
    start.mockReset();
    resume.mockReset();
    start.mockResolvedValue(ok({ outcome: 'started' }));
    resume.mockResolvedValue(ok({ outcome: 'resumed' }));
  });

  describe('browser tools for terminal agents', () => {
    const sessionMcp = {
      configPath: '/data/agent-mcp/conversation-1.json',
      servers: [
        {
          name: 'chorus-browser',
          url: 'http://127.0.0.1:4100/mcp',
          tokenEnvVar: 'CHORUS_BROWSER_MCP_TOKEN',
        },
      ],
    };

    it('scopes the session MCP server to the task and passes the token through env', async () => {
      const resolveSessionMcp = vi.fn(async () => ({
        sessionMcp,
        env: { CHORUS_BROWSER_MCP_TOKEN: 'chorus_bt_secret' },
      }));
      const provider = createProvider({ resolveSessionMcp });

      await provider.ensureSession({ conversation: conversation({}), mode: 'start' });

      expect(resolveSessionMcp).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        title: 'Conversation',
      });
      const input = start.mock.calls[0]?.[0];
      expect(input.sessionMcp).toEqual(sessionMcp);
      expect(input.providerVars).toMatchObject({ CHORUS_BROWSER_MCP_TOKEN: 'chorus_bt_secret' });
      expect(input.extraArgs.join(' ')).not.toContain('chorus_bt_secret');
    });

    it('skips remote hosts, which cannot reach the loopback server', async () => {
      const resolveSessionMcp = vi.fn(async () => ({ sessionMcp, env: {} }));
      const provider = createProvider({
        host: { type: 'remote', id: 'ssh-1' },
        resolveSessionMcp,
      });

      await provider.ensureSession({ conversation: conversation({}), mode: 'start' });

      expect(resolveSessionMcp).not.toHaveBeenCalled();
      expect(start.mock.calls[0]?.[0]).not.toHaveProperty('sessionMcp');
    });

    it('still starts the agent when the browser tools cannot be set up', async () => {
      const provider = createProvider({
        resolveSessionMcp: vi.fn(async () => {
          throw new Error('disk full');
        }),
      });

      await expect(
        provider.ensureSession({ conversation: conversation({}), mode: 'start' })
      ).resolves.toEqual({ outcome: 'started' });
      expect(start.mock.calls[0]?.[0]).not.toHaveProperty('sessionMcp');
    });
  });

  describe('Claude accounts', () => {
    const extra = { accountId: 'account-1', configDir: '/data/claude-accounts/account-1' };
    const accounts = (launch: typeof extra | null) => ({
      resolve: vi.fn(async (_accountId: string | undefined) => launch),
      prepare: vi.fn(async () => {}),
    });
    const sessionEnv = {
      getProviderConfig: async () => ({
        env: {
          ANTHROPIC_API_KEY: 'sk-settings',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-settings',
          CLAUDE_CONFIG_DIR: '/user/config',
          ANTHROPIC_BASE_URL: 'https://proxy',
        },
      }),
      launchEnv: { ANTHROPIC_AUTH_TOKEN: 'project-token', PROJECT_ONLY: 'project' },
    };
    const startedWith = async (
      overrides: Parameters<typeof createProvider>[0],
      conversationOverrides: Partial<Conversation> = {}
    ) => {
      await createProvider(overrides).ensureSession({
        conversation: conversation({ providerId: 'claude', ...conversationOverrides }),
        mode: 'start',
      });
      return start.mock.calls[0]?.[0];
    };

    it('runs an extra account from its prepared folder, without credentials that outrank it', async () => {
      const claudeAccounts = accounts(extra);

      const input = await startedWith(
        { ...sessionEnv, claudeAccounts },
        { claudeAccountId: 'account-1' }
      );

      expect(claudeAccounts.resolve).toHaveBeenCalledWith('account-1');
      expect(claudeAccounts.prepare).toHaveBeenCalledWith(extra);
      expect(input.providerVars).toEqual({
        ANTHROPIC_BASE_URL: 'https://proxy',
        PROJECT_ONLY: 'project',
        CLAUDE_CONFIG_DIR: '/data/claude-accounts/account-1',
      });
      // Also removed from what the session would inherit from the user's shell.
      expect(input.unsetEnv).toEqual([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]);
    });

    it('changes nothing for the primary account', async () => {
      const claudeAccounts = accounts(null);
      const withAccounts = await startedWith(
        { ...sessionEnv, claudeAccounts },
        { claudeAccountId: 'primary' }
      );
      start.mockClear();
      const withoutAccounts = await startedWith(sessionEnv);

      expect(withAccounts).toEqual(withoutAccounts);
      expect(withAccounts.providerVars).toMatchObject({
        ANTHROPIC_API_KEY: 'sk-settings',
        CLAUDE_CONFIG_DIR: '/user/config',
      });
      expect(withAccounts).not.toHaveProperty('unsetEnv');
      expect(claudeAccounts.prepare).not.toHaveBeenCalled();
    });

    it('uses whatever the account resolves to when its own account was removed', async () => {
      // The resolver answers with the default account for an id it no longer knows.
      const fallback = { accountId: 'account-2', configDir: '/data/claude-accounts/account-2' };
      const claudeAccounts = accounts(fallback);

      const input = await startedWith({ claudeAccounts }, { claudeAccountId: 'removed' });

      expect(claudeAccounts.resolve).toHaveBeenCalledWith('removed');
      expect(claudeAccounts.prepare).toHaveBeenCalledWith(fallback);
      expect(input.providerVars.CLAUDE_CONFIG_DIR).toBe('/data/claude-accounts/account-2');
    });

    it('passes on a conversation with no recorded account, which stays on primary', async () => {
      const claudeAccounts = accounts(null);

      const input = await startedWith({ ...sessionEnv, claudeAccounts });

      expect(claudeAccounts.resolve).toHaveBeenCalledWith(undefined);
      expect(input.providerVars.CLAUDE_CONFIG_DIR).toBe('/user/config');
      expect(input).not.toHaveProperty('unsetEnv');
    });

    it('brings the account folder up to date before the session starts', async () => {
      // The runtime writes workspace trust into the account's .claude.json when it starts the
      // session, so the folder (and that file) must exist by then.
      const order: string[] = [];
      start.mockImplementation(async () => {
        order.push('start');
        return ok({ outcome: 'started' });
      });
      const claudeAccounts = {
        resolve: async () => extra,
        prepare: async () => {
          order.push('prepare');
        },
      };

      const input = await startedWith({ claudeAccounts, autoTrustWorktrees: true });

      expect(order).toEqual(['prepare', 'start']);
      expect(input.trustWorkspace).toBe(true);
      expect(input.providerVars.CLAUDE_CONFIG_DIR).toBe(extra.configDir);
    });

    it('does not start the session when the account folder cannot be prepared', async () => {
      const claudeAccounts = {
        resolve: async () => extra,
        prepare: async () => {
          throw new Error('Could not prepare the Claude account folder: disk full');
        },
      };

      await expect(
        createProvider({ claudeAccounts }).ensureSession({
          conversation: conversation({ providerId: 'claude' }),
          mode: 'start',
        })
      ).rejects.toThrow(/disk full/);
      expect(start).not.toHaveBeenCalled();
    });

    it('hands a session asked to run in WSL the account for a native fallback only', async () => {
      const claudeAccounts = accounts(extra);

      const input = await startedWith(
        {
          claudeAccounts,
          launchEnv: sessionEnv.launchEnv,
          getProviderConfig: async () => ({ ...(await sessionEnv.getProviderConfig()), wsl: true }),
        },
        { claudeAccountId: 'account-1' }
      );

      // Inside WSL the session is exactly what it would be without accounts.
      expect(input.providerVars).toMatchObject({
        ANTHROPIC_API_KEY: 'sk-settings',
        CLAUDE_CONFIG_DIR: '/user/config',
      });
      expect(input).not.toHaveProperty('unsetEnv');
      // If no distro has the CLI the runtime starts it natively, under the account.
      expect(input.wsl.native).toEqual({
        providerVars: {
          ANTHROPIC_BASE_URL: 'https://proxy',
          PROJECT_ONLY: 'project',
          CLAUDE_CONFIG_DIR: '/data/claude-accounts/account-1',
        },
        unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      });
      expect(claudeAccounts.prepare).toHaveBeenCalledWith(extra);
    });

    it('sets nothing aside for a WSL session on the primary account', async () => {
      const input = await startedWith({
        claudeAccounts: accounts(null),
        getProviderConfig: async () => ({ wsl: true }),
      });

      expect(input.wsl).toBeDefined();
      expect(input.wsl).not.toHaveProperty('native');
    });

    it('leaves other providers and other hosts alone', async () => {
      const claudeAccounts = accounts(extra);

      const codex = await startedWith({ claudeAccounts }, { providerId: 'codex' as never });
      start.mockClear();
      const remote = await startedWith({ claudeAccounts, host: { type: 'remote', id: 'ssh-1' } });

      for (const input of [codex, remote]) {
        expect(input.providerVars).not.toHaveProperty('CLAUDE_CONFIG_DIR');
        expect(input).not.toHaveProperty('unsetEnv');
      }
      expect(claudeAccounts.resolve).not.toHaveBeenCalled();
    });
  });

  describe('sessions inside WSL2', () => {
    const wslMachine = { type: 'remote' as const, id: 'wsl-1' };
    const startedWith = async (overrides: Parameters<typeof createProvider>[0]) => {
      await createProvider(overrides).ensureSession({
        conversation: conversation({ providerId: 'claude' }),
        mode: 'start',
      });
      return start.mock.calls[0]?.[0];
    };

    it('carries over auto-approve set on this computer to a WSL machine', async () => {
      const localAutoApprove = vi.fn(async () => true);
      const input = await startedWith({
        host: wslMachine,
        isWslHost: async () => true,
        localAutoApprove,
      });

      expect(input.autoApprove).toBe(true);
      expect(localAutoApprove).toHaveBeenCalledWith('claude');
    });

    it('carries it over to an agent set to run in WSL on this computer', async () => {
      const input = await startedWith({
        getProviderConfig: async () => ({ wsl: true }),
        localAutoApprove: async () => true,
      });

      expect(input.autoApprove).toBe(true);
      expect(input.wsl).toBeDefined();
    });

    it('leaves sessions outside WSL as the conversation says', async () => {
      const localAutoApprove = vi.fn(async () => true);
      const native = await startedWith({ localAutoApprove });
      start.mockClear();
      const ssh = await startedWith({
        host: { type: 'remote', id: 'ssh-1' },
        isWslHost: async () => false,
        localAutoApprove,
      });

      expect(native.autoApprove).toBe(false);
      expect(ssh.autoApprove).toBe(false);
      expect(localAutoApprove).not.toHaveBeenCalled();
    });

    it('does not turn it on when this computer does not have it, or cannot be asked', async () => {
      const unset = await startedWith({
        host: wslMachine,
        isWslHost: async () => true,
        localAutoApprove: async () => false,
      });
      start.mockClear();
      const failed = await startedWith({
        host: wslMachine,
        isWslHost: async () => {
          throw new Error('database closed');
        },
        localAutoApprove: async () => true,
      });

      expect(unset.autoApprove).toBe(false);
      expect(failed.autoApprove).toBe(false);
    });
  });

  it('routes fresh starts to the runtime start path with the initial prompt', async () => {
    const provider = createProvider();

    const result = await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: undefined }),
      mode: 'start',
      initialPrompt: 'hello',
    });

    expect(result).toEqual({ outcome: 'started' });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        providerId: 'claude',
        sessionId: null,
        initialPrompt: 'hello',
        trustWorkspace: false,
      })
    );
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(['antigravity', 'codex', 'prime-agent'])(
    'routes native-id provider %s to the runtime resume path when a native id exists',
    async (providerId) => {
      const provider = createProvider();

      await provider.ensureSession({
        conversation: conversation({ providerId, sessionId: 'native-session' }),
        mode: 'resume',
        initialPrompt: 'do not replay',
      });

      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId,
          sessionId: 'native-session',
          initialPrompt: undefined,
        })
      );
      expect(start).not.toHaveBeenCalled();
    }
  );

  it.each([
    { providerId: 'antigravity', sessionId: undefined },
    { providerId: 'antigravity', sessionId: 'conversation-1' },
    { providerId: 'codex', sessionId: undefined },
    { providerId: 'codex', sessionId: 'conversation-1' },
    { providerId: 'prime-agent', sessionId: undefined },
    { providerId: 'prime-agent', sessionId: 'conversation-1' },
  ])(
    'starts $providerId fresh without replaying the prompt when sessionId is $sessionId',
    async ({ providerId, sessionId }) => {
      const provider = createProvider();

      await provider.ensureSession({
        conversation: conversation({ providerId, sessionId }),
        mode: 'resume',
        initialPrompt: 'do not replay',
      });

      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId,
          sessionId: null,
          initialPrompt: undefined,
        })
      );
      expect(resume).not.toHaveBeenCalled();
    }
  );

  it('resumes claude with a hook-captured session id that differs from the conversation id', async () => {
    const provider = createProvider();

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: 'native-session' }),
      mode: 'resume',
    });

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', sessionId: 'native-session' })
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('resumes claude with the conversation id when no other session id was captured', async () => {
    const provider = createProvider();

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', sessionId: 'conversation-1' }),
      mode: 'resume',
    });

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'claude', sessionId: 'conversation-1' })
    );
  });

  it.each([
    { label: 'local', host: { type: 'local', id: 'local' } as const },
    { label: 'remote', host: { type: 'remote', id: 'ssh-1' } as const },
  ])('sends the settings-driven trust verdict to the $label runtime', async ({ host }) => {
    const provider = createProvider({ host, autoTrustWorktrees: true });

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude' }),
      mode: 'start',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ trustWorkspace: true }));
  });

  it('forces runtime trust for auto-approved conversations without reading settings', async () => {
    const getTaskSettings = vi.fn(async () => ({ autoTrustWorktrees: false }));
    const provider = createProvider({
      host: { type: 'remote', id: 'ssh-1' },
      getTaskSettings,
    });

    await provider.ensureSession({
      conversation: conversation({ providerId: 'claude', autoApprove: true }),
      mode: 'start',
    });

    expect(getTaskSettings).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ trustWorkspace: true }));
  });

  it('resolves mutable task launch context immediately before each fresh start', async () => {
    let launchContext = {
      workspace: {
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        host: { type: 'local', id: 'local' } as const,
        path: '/workspace',
      },
      tmux: false,
      shellSetup: 'source old-profile',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-old',
        EMDASH_TASK_NAME: 'old-name',
      },
    };
    const resolve = vi.fn(async () => ok(launchContext));
    const provider = createProvider({ launchContextSource: { resolve } });

    await provider.ensureSession({
      conversation: conversation({ id: 'conversation-1', providerId: 'claude' }),
      mode: 'start',
    });

    launchContext = {
      ...launchContext,
      tmux: true,
      shellSetup: 'source new-profile',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-new',
        EMDASH_TASK_NAME: 'new-name',
      },
    };
    await provider.ensureSession({
      conversation: conversation({ id: 'conversation-2', providerId: 'claude' }),
      mode: 'start',
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerVars: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/tmp/claude-old',
          EMDASH_TASK_NAME: 'old-name',
        }),
        shellSetup: 'source old-profile',
      })
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerVars: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/tmp/claude-new',
          EMDASH_TASK_NAME: 'new-name',
        }),
        shellSetup: 'source new-profile',
        tmux: { identity: expect.stringMatching(/:/) },
      })
    );
  });
});

function createProvider(
  overrides: {
    host?: TuiConversationProviderOptions['host'];
    autoTrustWorktrees?: boolean;
    getTaskSettings?: () => Promise<{ autoTrustWorktrees: boolean }>;
    launchContextSource?: TuiConversationProviderOptions['launchContextSource'];
    resolveSessionMcp?: TuiConversationProviderDependencies['resolveSessionMcp'];
    getProviderConfig?: TuiConversationProviderDependencies['getProviderConfig'];
    isWslHost?: TuiConversationProviderDependencies['isWslHost'];
    localAutoApprove?: TuiConversationProviderDependencies['localAutoApprove'];
    claudeAccounts?: TuiConversationProviderDependencies['claudeAccounts'];
    launchEnv?: Record<string, string>;
  } = {}
): TuiConversationProvider {
  return new TuiConversationProvider(
    {
      host: overrides.host ?? { type: 'local', id: 'local' },
      tuiAgents: { start, resume } as never,
      projectId: 'project-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
      taskPath: '/workspace',
      launchContextSource: overrides.launchContextSource ?? {
        resolve: async () =>
          ok({
            workspace: {
              workspaceId: 'workspace-1',
              projectId: 'project-1',
              host: overrides.host ?? { type: 'local', id: 'local' },
              path: '/workspace',
            },
            tmux: false,
            env: overrides.launchEnv ?? {},
          }),
      },
    },
    {
      db: { select: vi.fn() } as never,
      getProviderConfig: overrides.getProviderConfig ?? (() => Promise.resolve(undefined)),
      getTaskSettings:
        overrides.getTaskSettings ??
        (() => Promise.resolve({ autoTrustWorktrees: overrides.autoTrustWorktrees ?? false })),
      getTerminalColorEnv: () => Promise.resolve({}),
      resolveSessionGitCredentials: () => Promise.resolve(undefined),
      ...(overrides.resolveSessionMcp ? { resolveSessionMcp: overrides.resolveSessionMcp } : {}),
      ...(overrides.isWslHost ? { isWslHost: overrides.isWslHost } : {}),
      ...(overrides.localAutoApprove ? { localAutoApprove: overrides.localAutoApprove } : {}),
      ...(overrides.claudeAccounts ? { claudeAccounts: overrides.claudeAccounts } : {}),
    }
  );
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'claude',
    title: 'Conversation',
    lastInteractedAt: null,
    isInitialConversation: false,
    type: 'pty',
    ...overrides,
  };
}
