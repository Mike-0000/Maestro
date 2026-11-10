import type { GitCredentialsSessionSpec } from '@emdash/core/primitives/git-credentials/api';
import { isLocalHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import type { TuiAgentStartInput } from '@emdash/core/runtimes/tui-agents/api';
import { and, eq } from 'drizzle-orm';
import {
  applyClaudeAccountEnv,
  CLAUDE_ACCOUNTS_PROVIDER_ID,
  type ClaudeAccountLaunch,
  type ClaudeAccountLaunchResolver,
} from '@core/features/claude-accounts/api/node/launch';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import type {
  ConversationProvider,
  EnsureConversationSessionRequest,
  EnsureConversationSessionResult,
} from '@core/features/conversations/api/node/types';
import type { TaskSessionLaunchContextSource } from '@core/features/tasks/api/node/task-session-launch-context';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import type { Conversation } from '@core/primitives/conversations/api';
import { makePtySessionId } from '@core/primitives/pty/api';
import type { AppDb } from '@core/services/app-db/node/db';
import type { TuiAgentsRuntimeClient } from '@core/services/runtime-broker/api/clients';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const PROVIDER_SESSION_ID_REQUIRED_FOR_RESUME = new Set([
  'amp',
  'antigravity',
  'codex',
  'commandcode',
  'droid',
  'goose',
  'oh-my-pi',
  'pi',
  'prime-agent',
]);

export type TuiConversationProviderOptions = {
  host: HostRef;
  tuiAgents: TuiAgentsRuntimeClient;
  projectId: string;
  taskId: string;
  workspaceId?: string;
  taskPath: string;
  launchContextSource: TaskSessionLaunchContextSource;
};

export type TuiSessionMcp = {
  sessionMcp: NonNullable<TuiAgentStartInput['sessionMcp']>;
  /** Secrets the CLI reads by name (for example bearer tokens); merged into the session env. */
  env: Record<string, string>;
};

export type TuiConversationProviderDependencies = {
  db: AppDb;
  getProviderConfig(providerId: string): Promise<ProviderCustomConfig | undefined>;
  getTaskSettings(): Promise<{ autoTrustWorktrees: boolean }>;
  getTerminalColorEnv(): Promise<Record<string, string>>;
  /**
   * Per-session git credential behavior from the project's "agent git
   * credentials" setting (spec: github-git-settings §4); constructed into the
   * session env by the tui-agents runtime through the blessed builder.
   */
  resolveSessionGitCredentials(params: {
    projectId: string;
    host: HostRef;
  }): Promise<GitCredentialsSessionSpec | undefined>;
  /**
   * Per-session loopback MCP servers (Maestro's browser tools and conductor requests). Only asked
   * for local sessions, since loopback servers cannot reach agents on other hosts.
   */
  resolveSessionMcp?(context: {
    conversationId: string;
    projectId: string;
    workspaceId: string;
    taskId: string;
    title: string;
  }): Promise<TuiSessionMcp | undefined>;
  /**
   * Claude accounts: which account a Claude Code session runs under. Without it every session
   * uses the primary sign-in.
   */
  claudeAccounts?: ClaudeAccountLaunchResolver;
  /** Whether the host is a WSL2 distro on this computer. */
  isWslHost?(host: HostRef): Promise<boolean>;
  /**
   * Whether the user's own configuration on this computer starts the agent without permission
   * prompts. Only asked for sessions inside WSL2, which do not read that configuration.
   */
  localAutoApprove?(providerId: string): Promise<boolean>;
};

/**
 * What a provider needs to run inside WSL2: where its configuration directory is, so its hooks
 * can be installed in the distro. Only Claude Code is offered the setting today.
 */
function wslLaunchFor(providerId: string): NonNullable<TuiAgentStartInput['wsl']> {
  return providerId === 'claude'
    ? { configRoot: { env: 'CLAUDE_CONFIG_DIR', directory: '.claude' } }
    : {};
}

function parseExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.trim().split(/\s+/);
}

export class TuiConversationProvider implements ConversationProvider {
  private readonly projectId: string;
  private readonly taskId: string;
  private readonly workspaceId: string | undefined;
  private readonly taskPath: string;
  private readonly host: HostRef;
  private readonly tuiAgents: TuiAgentsRuntimeClient;
  private readonly launchContextSource: TaskSessionLaunchContextSource;

  constructor(
    options: TuiConversationProviderOptions,
    private readonly dependencies: TuiConversationProviderDependencies
  ) {
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.workspaceId = options.workspaceId;
    this.taskPath = options.taskPath;
    this.host = options.host;
    this.tuiAgents = options.tuiAgents;
    this.launchContextSource = options.launchContextSource;
  }

  async ensureSession({
    conversation,
    mode,
    initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    initialPrompt,
  }: EnsureConversationSessionRequest): Promise<EnsureConversationSessionResult> {
    const input = await this.buildStartInput(conversation, initialSize, mode, initialPrompt);
    const agentSession = resolveAgentSession(conversation, mode);
    const result = agentSession.isResuming
      ? await this.tuiAgents.resume(input)
      : await this.tuiAgents.start(input);
    if (!result.success) {
      throw new Error(`TUI session failed to start: ${JSON.stringify(result.error)}`);
    }
    return { outcome: result.data.outcome };
  }

  async detachSession(_conversationId: string): Promise<void> {
    // Output subscriptions are passive; explicit control and workspace teardown own PTY lifetime.
  }

  async stopSession(conversationId: string): Promise<void> {
    await this.tuiAgents.stop({ conversationId });
  }

  async deleteSession(conversationId: string): Promise<void> {
    await this.tuiAgents.delete({ conversationId });
  }

  async destroyAll(): Promise<void> {
    const rows = await this.dependencies.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.taskId, this.taskId), eq(conversations.type, 'pty')));
    await Promise.all(rows.map((row) => this.stopSession(row.id)));
  }

  async detachAll(): Promise<void> {
    // Runtime leases are held by renderer output bindings; no provider-owned PTY to detach.
  }

  private async buildStartInput(
    conversation: Conversation,
    initialSize: { cols: number; rows: number },
    mode: 'start' | 'resume',
    initialPrompt: string | undefined
  ): Promise<TuiAgentStartInput> {
    const agentSession = resolveAgentSession(conversation, mode);
    const effectiveInitialPrompt =
      !agentSession.isResuming && mode === 'start' ? initialPrompt : undefined;
    const [providerConfig, taskSettings, colorEnv, launchContext, gitCredentials, sessionMcp] =
      await Promise.all([
        this.dependencies.getProviderConfig(conversation.providerId),
        conversation.autoApprove === true
          ? Promise.resolve(undefined)
          : this.dependencies.getTaskSettings(),
        this.dependencies.getTerminalColorEnv(),
        this.launchContextSource.resolve(),
        this.dependencies.resolveSessionGitCredentials({
          projectId: this.projectId,
          host: this.host,
        }),
        this.resolveSessionMcp(conversation),
      ]);
    if (!launchContext.success) {
      throw new Error(`Could not resolve task session launch context: ${launchContext.error.type}`);
    }
    const trustWorkspace =
      conversation.autoApprove === true || taskSettings?.autoTrustWorktrees === true;
    const wslOnLocalHost = providerConfig?.wsl === true && isLocalHostRef(this.host);
    const autoApprove =
      conversation.autoApprove === true ||
      (await this.localAutoApproveInWsl(conversation.providerId, wslOnLocalHost));
    const sessionVars = {
      ...(providerConfig?.env ?? {}),
      ...colorEnv,
      ...launchContext.data.env,
      ...sessionMcp?.env,
    };
    const claudeAccount = await this.prepareClaudeAccount(conversation);
    // Primary account: the variables are left exactly as they were.
    const accountEnv = claudeAccount
      ? applyClaudeAccountEnv(sessionVars, claudeAccount)
      : undefined;
    // The account's folder is on this computer. A session asked to run inside WSL2 keeps the
    // distro's own sign-in there, and gets the account only if it starts natively after all;
    // the runtime knows which, so it is handed both.
    const providerVars = accountEnv && !wslOnLocalHost ? accountEnv.env : sessionVars;
    const wslLaunch = wslOnLocalHost
      ? {
          ...wslLaunchFor(conversation.providerId),
          ...(accountEnv
            ? { native: { providerVars: accountEnv.env, unsetEnv: accountEnv.unsetEnv } }
            : {}),
        }
      : undefined;
    const sessionId = makePtySessionId(this.projectId, this.taskId, conversation.id);

    return {
      conversationId: conversation.id,
      providerId: conversation.providerId,
      cwd: this.taskPath,
      sessionId: agentSession.isResuming ? agentSession.sessionId : null,
      // Fresh spawns declare the emdash-chosen resume handle (resolveAgentSession falls
      // back to the conversation id), so the index learns it at spawn (spec §3.1).
      chosenSessionId: agentSession.isResuming ? null : agentSession.sessionId,
      model: conversation.model ?? null,
      initialPrompt: effectiveInitialPrompt,
      autoApprove,
      trustWorkspace,
      extraArgs: parseExtraArgs(providerConfig?.extraArgs),
      providerVars,
      ...(accountEnv && !wslOnLocalHost ? { unsetEnv: accountEnv.unsetEnv } : {}),
      gitCredentials,
      ...(sessionMcp ? { sessionMcp: sessionMcp.sessionMcp } : {}),
      cols: initialSize.cols,
      rows: initialSize.rows,
      shellSetup: launchContext.data.shellSetup,
      tmux: launchContext.data.tmux ? { identity: sessionId } : undefined,
      ...(wslLaunch ? { wsl: wslLaunch } : {}),
    };
  }

  /**
   * The extra Claude account this session runs under, with its folder brought up to date, or
   * null for the primary account. The folder is on this computer, so sessions on another host
   * keep that host's own sign-in.
   */
  private async prepareClaudeAccount(
    conversation: Conversation
  ): Promise<ClaudeAccountLaunch | null> {
    const accounts = this.dependencies.claudeAccounts;
    if (!accounts || conversation.providerId !== CLAUDE_ACCOUNTS_PROVIDER_ID) return null;
    if (!isLocalHostRef(this.host)) return null;
    const launch = await accounts.resolve(conversation.claudeAccountId);
    if (launch) await accounts.prepare(launch);
    return launch;
  }

  /**
   * A session inside WSL2 runs the distro's copy of the agent, which reads the distro's
   * configuration. When the user set the agent on this computer to start without permission
   * prompts, that is carried over on the command line, so both start the same way. Best effort:
   * when it cannot be found out, the session starts as the conversation says.
   */
  private async localAutoApproveInWsl(
    providerId: string,
    wslOnLocalHost: boolean
  ): Promise<boolean> {
    const { isWslHost, localAutoApprove } = this.dependencies;
    if (!localAutoApprove) return false;
    try {
      const inWsl = wslOnLocalHost || ((await isWslHost?.(this.host)) ?? false);
      return inWsl && (await localAutoApprove(providerId));
    } catch {
      return false;
    }
  }

  /** Best effort: a session without Maestro's tools beats a session that fails to start. */
  private async resolveSessionMcp(conversation: Conversation): Promise<TuiSessionMcp | undefined> {
    const resolve = this.dependencies.resolveSessionMcp;
    if (!resolve || !this.workspaceId || !isLocalHostRef(this.host)) return undefined;
    return resolve({
      conversationId: conversation.id,
      projectId: this.projectId,
      workspaceId: this.workspaceId,
      taskId: this.taskId,
      title: conversation.title,
    }).catch(() => undefined);
  }
}

function resolveAgentSession(
  conversation: Conversation,
  mode: 'start' | 'resume'
): { sessionId: string; isResuming: boolean } {
  const isResuming = mode === 'resume';
  const nativeSessionId = conversation.sessionId;
  const hasNativeSessionId = Boolean(nativeSessionId) && nativeSessionId !== conversation.id;
  if (PROVIDER_SESSION_ID_REQUIRED_FOR_RESUME.has(conversation.providerId) && isResuming) {
    if (hasNativeSessionId) return { sessionId: nativeSessionId!, isResuming: true };
    return { sessionId: conversation.id, isResuming: false };
  }
  if (isResuming && hasNativeSessionId) return { sessionId: nativeSessionId!, isResuming };
  return { sessionId: conversation.id, isResuming };
}
