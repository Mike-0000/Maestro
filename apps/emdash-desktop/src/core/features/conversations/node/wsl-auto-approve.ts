import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sshConnectionIdOf, type HostRef } from '@emdash/core/primitives/host/api';
import { eq } from 'drizzle-orm';
import type { AppDb } from '@core/services/app-db/node/db';
import { sshConnections } from '@core/services/app-db/node/schema';

/**
 * Whether Claude Code on this computer starts without permission prompts by the user's own
 * configuration: `permissions.defaultMode` in their settings file. A session on this computer
 * reads that file itself. A WSL2 distro has a settings file of its own, so a session there does
 * not see it and has to be told on its command line.
 */
export async function claudeBypassesPermissionsHere(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<boolean> {
  const root = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  try {
    const settings: unknown = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    if (typeof settings !== 'object' || settings === null) return false;
    const permissions: unknown = (settings as Record<string, unknown>).permissions;
    if (typeof permissions !== 'object' || permissions === null) return false;
    return (permissions as Record<string, unknown>).defaultMode === 'bypassPermissions';
  } catch {
    // No settings file, or one that cannot be read: nothing was set.
    return false;
  }
}

/**
 * What a session inside WSL2 takes over from this computer. Only Claude Code has a setting that
 * is carried over today.
 */
export function createWslAutoApprove(db: AppDb): {
  isWslHost(host: HostRef): Promise<boolean>;
  localAutoApprove(providerId: string): Promise<boolean>;
} {
  return {
    isWslHost: async (host) => {
      const connectionId = sshConnectionIdOf(host);
      if (!connectionId) return false;
      const [connection] = await db
        .select({ metadata: sshConnections.metadata })
        .from(sshConnections)
        .where(eq(sshConnections.id, connectionId))
        .limit(1);
      return connection?.metadata?.transport === 'wsl';
    },
    localAutoApprove: (providerId) =>
      providerId === 'claude' ? claudeBypassesPermissionsHere() : Promise.resolve(false),
  };
}
