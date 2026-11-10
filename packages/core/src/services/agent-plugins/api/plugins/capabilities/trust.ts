import { definePluginCapability } from '@emdash/shared/plugins';
import z from 'zod';
import type { PluginFs } from '#primitives/plugin-fs/api';
import type { ConfigRootResolver } from '#services/agent-plugins/api/plugins/helpers/config-root';

export type TrustContext = {
  workspacePath: string;
};

export type ITrustBehavior = {
  trustWorkspace(fs: PluginFs, ctx: TrustContext): Promise<void>;
  /**
   * The directory the trust record lives in for a session with this environment; `fs` is
   * rooted there. Absent means the user's home directory. Providers whose record moves with a
   * configuration-directory variable resolve it here, so a session started under another
   * configuration directory is trusted where its CLI will look.
   */
  resolveConfigRoot?: ConfigRootResolver;
};

export const trustCapability = definePluginCapability<ITrustBehavior>()(
  'trust',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('supported'),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  { kind: 'none' }
);
