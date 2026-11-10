import {
  buildAllowlistedAgentEnv,
  currentAgentEnvPlatform,
  mergeAgentEnvLayers,
} from '@emdash/core/primitives/agent-env/api';
import { createBoundExec, ExecError } from '@emdash/core/services/exec/api';
import { applyClaudeAccountEnv, type ClaudeAccountLaunch } from '../api/node/launch';

const CLI_TIMEOUT_MS = 15_000;

export type ClaudeCliResult = { exitCode: number | null; stdout: string };

/**
 * Runs one short Claude Code command for an account: under the account's configuration
 * directory for an extra account, or as the app would run Claude Code anyway for the primary
 * one (`launch` null). Rejects only when the command could not be run at all.
 */
export type ClaudeCliRunner = (
  args: string[],
  launch: ClaudeAccountLaunch | null
) => Promise<ClaudeCliResult>;

export type ClaudeCliRunnerDeps = {
  /** Absolute path of the Claude Code CLI, or null when it is not installed. */
  resolveCli(): Promise<string | null>;
  /** The app's own environment; only the agent allowlist of it reaches the CLI. */
  processEnv: Readonly<Record<string, string | undefined>>;
  /** What the user set for Claude Code in Settings, applied over the allowlist. */
  providerEnv(): Promise<Record<string, string>>;
  homeDir: string;
};

export function createClaudeCliRunner(deps: ClaudeCliRunnerDeps): ClaudeCliRunner {
  return async (args, launch) => {
    const cli = await deps.resolveCli();
    if (!cli) throw new Error('The Claude Code CLI is not installed');
    // This is the child's whole environment, so dropping a name here removes it for good.
    const base = mergeAgentEnvLayers(
      currentAgentEnvPlatform(),
      buildAllowlistedAgentEnv(deps.processEnv, { homeDir: deps.homeDir }),
      await deps.providerEnv()
    );
    const env = launch ? applyClaudeAccountEnv(base, launch).env : base;
    try {
      const { stdout } = await createBoundExec({ file: cli, cwd: deps.homeDir, env }).exec(args, {
        timeoutMs: CLI_TIMEOUT_MS,
        windowsHide: true,
      });
      return { exitCode: 0, stdout };
    } catch (error) {
      // A non-zero exit is an answer (signed out exits 1); only a failed start is an error.
      if (error instanceof ExecError && error.exitCode !== null) {
        return { exitCode: error.exitCode, stdout: error.stdout };
      }
      throw new Error('The Claude Code CLI could not be run', { cause: error });
    }
  };
}
