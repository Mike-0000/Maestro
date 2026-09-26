import { definePluginCapability } from '@emdash/shared/plugins';
import z from 'zod';
import type { McpServerRegistration } from '#primitives/mcp/api';
import type { PluginFs } from '#primitives/plugin-fs/api';

/**
 * A loopback HTTP MCP server handed to one TUI session only (for example Chorus's browser
 * server). The bearer token travels in `tokenEnvVar` of the session env; `configPath` is a
 * host-written MCP JSON file (`{ "mcpServers": { name: { type, url, headers } } }`) holding every
 * session server, for CLIs that load servers from a file.
 */
export type SessionMcpServer = {
  name: string;
  url: string;
  tokenEnvVar: string;
};

export type SessionMcpLaunch = {
  servers: SessionMcpServer[];
  configPath: string;
};

export type IMcpBehavior = {
  readServers(fs: PluginFs): Promise<McpServerRegistration[]>;
  writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void>;
  removeServer(fs: PluginFs, name: string): Promise<void>;
  /**
   * CLI arguments that add per-session MCP servers on top of the user's own config, without
   * touching config files. Providers without a per-invocation flag omit it.
   */
  sessionArgs?(launch: SessionMcpLaunch): string[];
};

export type { McpServerRegistration } from '#primitives/mcp/api';

export const mcpCapability = definePluginCapability<IMcpBehavior>()(
  'mcp',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('supported'),
      scope: z.enum(['global']),
      supportedTransports: z.array(z.enum(['stdio', 'http'])),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  { kind: 'none' }
);
