import {
  buildJsonConfigTrustBehavior,
  envConfigRoot,
} from '@emdash/core/services/agent-plugins/api/plugins/helpers';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withClaudeTrustedProject(
  config: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  const projects = isPlainObject(config.projects) ? config.projects : {};
  const existing = isPlainObject(projects[workspacePath]) ? projects[workspacePath] : {};

  const alreadyTrusted =
    existing['hasTrustDialogAccepted'] === true &&
    existing['hasCompletedProjectOnboarding'] === true;
  if (alreadyTrusted) return null;

  return {
    ...config,
    projects: {
      ...projects,
      [workspacePath]: {
        ...existing,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  };
}

export function buildClaudeTrustBehavior() {
  return buildJsonConfigTrustBehavior({
    configName: '.claude.json',
    withTrustedPath: withClaudeTrustedProject,
    // Claude Code keeps `.claude.json` in its configuration directory when one is set, and in
    // the home directory otherwise.
    resolveConfigRoot: envConfigRoot('CLAUDE_CONFIG_DIR', '.'),
  });
}
