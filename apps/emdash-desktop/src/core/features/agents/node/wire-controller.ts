import { isLocalHostRef, sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import type { AgentProviderId } from '@emdash/plugins/agents/types';
import { err, ok, type Result } from '@emdash/shared';
import type { LiveModelProvider, LiveSource } from '@emdash/wire/rpc';
import { createController, type CallMeta, type Controller } from '@emdash/wire/rpc';
import type { AgentOperations } from '@core/features/agents/node/controller';
import { PRIMARY_CLAUDE_ACCOUNT_ID } from '@core/features/claude-accounts/api/types';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { agentsContract } from '../api';
import {
  throwAgentsRuntimeResolveError,
  type AgentsDependencyId as DependencyId,
  type AgentsHostRuntimesClient as HostRuntimesClient,
  type AgentsRuntimeBroker,
  type AgentsRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';

/** Variables for a sign-in that targets an extra account instead of the provider's own. */
export type AccountLoginEnv = { env: Record<string, string>; unsetEnv: string[] };

export type CreateAgentsWireControllerOptions = Readonly<{
  operations: AgentOperations;
  runtimes: AgentsRuntimeBroker;
  /**
   * Resolves the login environment of a Claude account on this computer, preparing its
   * folder. Null means the primary account: the login runs as it always has. Throws when the
   * account does not exist.
   */
  resolveClaudeAccountLogin?: (accountId: string) => Promise<AccountLoginEnv | null>;
}>;

export function createAgentsWireController(options: CreateAgentsWireControllerOptions): Controller {
  const agentOperations = options.operations;
  return createController(agentsContract, {
    listMetadata: () => agentOperations.listMetadata(),
    list: ({ host }) =>
      withHostRuntime(options.runtimes, host, (runtime) =>
        agentOperations.list(sshConnectionIdOf(host), runtime.hostDependencies)
      ),
    get: ({ host, id }) =>
      withHostRuntime(options.runtimes, host, (runtime) =>
        agentOperations.get(id, sshConnectionIdOf(host), runtime.hostDependencies)
      ),
    listAgentInstallationStatus: ({ host }) =>
      withHostRuntime(options.runtimes, host, (runtime) =>
        agentOperations.listAgentInstallationStatus(
          sshConnectionIdOf(host),
          runtime.hostDependencies
        )
      ),
    install: {
      run: async ({ host, id, method, elevate }, context) => {
        const runtime = await options.runtimes.client(host);
        if (!runtime.success) return err(runtime.error);
        return await agentOperations.install(
          id as AgentProviderId,
          sshConnectionIdOf(host),
          method,
          elevate,
          runtime.data.hostDependencies,
          context
        );
      },
      toError: toAgentOperationError,
    },
    update: {
      run: async ({ host, id, method, elevate }, context) => {
        const runtime = await options.runtimes.client(host);
        if (!runtime.success) return err(runtime.error);
        return await agentOperations.update(
          id as AgentProviderId,
          sshConnectionIdOf(host),
          method,
          elevate,
          runtime.data.hostDependencies,
          context
        );
      },
      toError: toAgentOperationError,
    },
    uninstall: ({ host, id, method }) =>
      withHostRuntime(options.runtimes, host, () =>
        agentOperations.uninstall(id as AgentProviderId, sshConnectionIdOf(host), method)
      ),
    getDefaultSettings: ({ host, id }) =>
      withHostRuntime(options.runtimes, host, () => agentOperations.getDefaultSettings(id)),
    getSettings: ({ host, id }) =>
      withHostRuntime(options.runtimes, host, () => agentOperations.getSettings(id)),
    updateSettings: ({ host, id, config }) =>
      withHostRuntime(options.runtimes, host, () => agentOperations.updateSettings(id, config)),
    setUsedInstallation: ({ host, id, selection }) =>
      withHostResult(options.runtimes, host, (runtime) =>
        agentOperations.setUsedInstallation(
          id as DependencyId,
          sshConnectionIdOf(host),
          selection,
          runtime.hostDependencies
        )
      ),
    resolveInstallation: ({ host, id, selection }) =>
      withHostResult(options.runtimes, host, (runtime) =>
        agentOperations.resolveInstallation(
          id as DependencyId,
          selection,
          sshConnectionIdOf(host),
          runtime.hostDependencies
        )
      ),
    refreshLatestVersion: ({ host, id }) =>
      withHostRuntime(options.runtimes, host, () =>
        agentOperations.refreshLatestVersion(id as DependencyId, sshConnectionIdOf(host))
      ),
    probeAll: ({ host }) =>
      withHostRuntime(options.runtimes, host, (runtime) =>
        agentOperations.probeAll(sshConnectionIdOf(host), runtime.hostDependencies)
      ),

    auth: createAuthModelProvider(options.runtimes),
    hooksStatus: ({ host, providerId }, meta) =>
      withHostRuntime(options.runtimes, host, (runtime) =>
        runtime.agentConfig.hooksStatus({ providerId }, callOptions(meta))
      ),
    startLogin: async ({ claudeAccountId, ...input }, meta) => {
      let account: AccountLoginEnv | null = null;
      if (claudeAccountId !== undefined) {
        const resolved = await resolveAccountLogin(options, input, claudeAccountId);
        if (!resolved.success) return resolved;
        account = resolved.data;
      }
      return withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.startLogin({ ...withoutHost(input), ...account }, callOptions(meta))
      );
    },
    cancelLogin: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.cancelLogin(withoutHost(input), callOptions(meta))
      ),
    sendLoginInput: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.sendLoginInput(withoutHost(input), callOptions(meta))
      ),
    resizeLogin: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.resizeLogin(withoutHost(input), callOptions(meta))
      ),
    markUrlHandled: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.markUrlHandled(withoutHost(input), callOptions(meta))
      ),
    refreshAuthStatus: (input, meta) =>
      withAgentConfigResult(options.runtimes, input.host, (client) =>
        client.refreshAuthStatus(withoutHost(input), callOptions(meta))
      ),
    loginOutput: async ({ host, providerId }) =>
      resolveRuntimeSource(options.runtimes, host, (runtime) =>
        runtime.agentConfig.loginOutput.handle({ providerId }).asLiveSource()
      ),
  });
}

function createAuthModelProvider(
  runtimes: AgentsRuntimeBroker
): LiveModelProvider<typeof agentsContract.auth> {
  return forwardLiveModel(agentsContract.auth, (key, name) =>
    resolveRuntimeSource(runtimes, key.host, (runtime) =>
      runtime.agentConfig.agents.state(undefined, name).asLiveSource()
    )
  );
}

async function withHostRuntime<T>(
  runtimes: AgentsRuntimeBroker,
  host: HostRef,
  work: (client: HostRuntimesClient) => Promise<T> | T
): Promise<Result<T, RuntimeResolveError>> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtime.error);
  return ok(await work(runtime.data));
}

async function withHostResult<T, E>(
  runtimes: AgentsRuntimeBroker,
  host: HostRef,
  work: (client: HostRuntimesClient) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError>> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtime.error);
  return work(runtime.data);
}

async function withAgentConfigResult<T, E>(
  runtimes: AgentsRuntimeBroker,
  host: HostRef,
  work: (client: HostRuntimesClient['agentConfig']) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError>> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) return err(runtime.error);
  return await work(runtime.data.agentConfig);
}

async function resolveRuntimeSource(
  runtimes: AgentsRuntimeBroker,
  host: HostRef,
  source: (client: HostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const runtime = await runtimes.client(host);
  if (!runtime.success) throwAgentsRuntimeResolveError(runtime.error);
  return source(runtime.data);
}

async function resolveAccountLogin(
  options: CreateAgentsWireControllerOptions,
  input: { host: HostRef; providerId: string },
  accountId: string
): Promise<Result<AccountLoginEnv | null, { type: 'invalid-state'; message: string }>> {
  // The primary account is the provider's ordinary sign-in, on whatever host and provider.
  if (accountId === PRIMARY_CLAUDE_ACCOUNT_ID) return ok(null);
  const resolve = options.resolveClaudeAccountLogin;
  if (!resolve || input.providerId !== 'claude' || !isLocalHostRef(input.host)) {
    return err({
      type: 'invalid-state',
      message: 'Claude accounts can only be signed in to with Claude Code on this computer',
    });
  }
  try {
    return ok(await resolve(accountId));
  } catch (error) {
    return err({
      type: 'invalid-state',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function withoutHost<T extends { host: HostRef }>(input: T): Omit<T, 'host'> {
  const { host: _, ...rest } = input;
  return rest;
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}

function toAgentOperationError(error: unknown) {
  return {
    type: 'command-failed' as const,
    message: error instanceof Error ? error.message : String(error),
    output: '',
  };
}
