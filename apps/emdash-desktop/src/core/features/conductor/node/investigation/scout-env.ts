import {
  buildAllowlistedAgentEnv,
  currentAgentEnvPlatform,
  mergeAgentEnvLayers,
  type AgentEnvPlatform,
} from '@emdash/core/primitives/agent-env/api';

/**
 * The environment a code scout runs in: the agent allowlist, cut down to what Claude Code needs
 * to start, reach the network, and sign in. Nothing of Maestro's own (hook ports, session ids)
 * and no other provider's key reaches the child.
 */

/** Process basics, proxies, and the ways Claude Code can be told where and how to sign in. */
const KEPT_NAMES = new Set(
  [
    'PATH',
    'HOME',
    'USER',
    'TERM',
    'COLORTERM',
    'TERM_PROGRAM',
    'LANG',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    // Without these the scout's tools write a literal `%SystemDrive%` folder into the project.
    'SystemDrive',
    'ProgramData',
    'ALLUSERSPROFILE',
    'windir',
    'ComSpec',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
  ].map((name) => name.toLowerCase())
);
const KEPT_PREFIXES = ['xdg_', 'anthropic_', 'aws_'];

function isKept(name: string): boolean {
  const lower = name.toLowerCase();
  return KEPT_NAMES.has(lower) || KEPT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * `processEnv` is the app's own environment. `providerEnv` is what the user set for Claude Code
 * in Settings; it is theirs to choose, so it is applied last and whole. The provider's extra
 * arguments are never applied to a scout.
 */
export function scoutEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  providerEnv: Readonly<Record<string, string>>,
  platform: AgentEnvPlatform = currentAgentEnvPlatform()
): Record<string, string> {
  const allowlisted = buildAllowlistedAgentEnv(processEnv, { platform });
  const kept = Object.fromEntries(Object.entries(allowlisted).filter(([name]) => isKept(name)));
  return mergeAgentEnvLayers(platform, kept, providerEnv);
}
