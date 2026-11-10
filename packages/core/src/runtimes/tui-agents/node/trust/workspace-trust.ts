import path from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { mergeAgentEnvLayers } from '#primitives/agent-env/api';
import type { AgentPluginHost, ITrustBehavior } from '#services/agent-plugins/api/plugins';
import { createLocalPluginFs } from '#services/agent-plugins/api/plugins/helpers';

export type TuiWorkspaceTrustOptions = {
  agentHost: AgentPluginHost;
  logger: Logger;
};

export class TuiWorkspaceTrust {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly options: TuiWorkspaceTrustOptions) {}

  /**
   * `env` is the session's own variables. A provider that keeps its trust record in a
   * configuration directory reads it from there, so the record is written where the session's
   * CLI will look for it.
   */
  async ensureTrusted(params: {
    providerId: string;
    workspacePath: string;
    env?: Record<string, string>;
  }): Promise<void> {
    const behavior = this.options.agentHost.get(params.providerId)?.behavior.trust;
    if (!behavior) return;

    if (!path.isAbsolute(params.workspacePath)) {
      this.options.logger.warn('TuiWorkspaceTrust: refusing to trust non-absolute workspace path', {
        providerId: params.providerId,
        workspacePath: params.workspacePath,
      });
      return;
    }

    const workspacePath = path.normalize(params.workspacePath);
    const run = () => this.applyTrust(behavior, params.providerId, workspacePath, params.env);
    const next = this.writeLock.then(run, run);
    this.writeLock = next;
    await next;
  }

  private async applyTrust(
    behavior: ITrustBehavior,
    providerId: string,
    workspacePath: string,
    env: Record<string, string> | undefined
  ): Promise<void> {
    try {
      const root = await this.configRoot(behavior, env);
      await behavior.trustWorkspace(createLocalPluginFs(root), { workspacePath });
    } catch (error) {
      this.options.logger.warn('TuiWorkspaceTrust: failed to trust workspace', {
        providerId,
        workspacePath,
        error: String(error),
      });
    }
  }

  /** The same resolution the hook installer uses: the agent environment under the session's. */
  private async configRoot(
    behavior: ITrustBehavior,
    env: Record<string, string> | undefined
  ): Promise<string> {
    if (!behavior.resolveConfigRoot) return this.options.agentHost.homeDir;
    const context = await this.options.agentHost.configRootContext();
    return behavior.resolveConfigRoot({
      ...context,
      env: mergeAgentEnvLayers(
        context.platform === 'windows' ? 'windows' : 'posix',
        context.env,
        env ?? {}
      ),
    });
  }
}
