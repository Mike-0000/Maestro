import { z } from 'zod';
import { mcpServerSchema } from '#primitives/mcp/api';
import {
  catalogSkillSchema,
  createSkillInputSchema,
  skillInstallPayloadSchema,
} from '#primitives/skills/api';
import { agentAuthStatusSchema } from '#services/agent-plugins/api/plugins/capabilities/auth';
import { runtimeUnavailableErrorSchema } from '#workspace-server/shared/schemas';

export const installCommandErrorSchema = z.union([
  z.object({
    type: z.literal('permission-denied'),
    message: z.string(),
    output: z.string(),
    exitCode: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('command-failed'),
    message: z.string(),
    output: z.string(),
    exitCode: z.number().int().optional(),
  }),
  z.object({ type: z.literal('pty-open-failed'), message: z.string() }),
]);

export const agentConfigUnknownProviderErrorSchema = z.object({
  type: z.literal('unknown-provider'),
  providerId: z.string(),
});
export const agentConfigInvalidStateErrorSchema = z.object({
  type: z.literal('invalid-state'),
  message: z.string(),
});
export const agentConfigIoErrorSchema = z.object({
  type: z.literal('io'),
  path: z.string().optional(),
  message: z.string(),
});

export const agentConfigErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  installCommandErrorSchema,
  runtimeUnavailableErrorSchema,
]);

export const agentConfigAuthErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  runtimeUnavailableErrorSchema,
]);
export const agentConfigMcpErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  runtimeUnavailableErrorSchema,
]);
export const agentConfigSkillsErrorSchema = z.union([
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  runtimeUnavailableErrorSchema,
]);
export const agentConfigAddonsErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  /** Files the add-on would overwrite that hold something else; retried with `replace`. */
  z.object({ type: z.literal('conflict'), paths: z.array(z.string()) }),
  runtimeUnavailableErrorSchema,
]);

/** One file of an add-on, at a path relative to the provider's config folder. */
export const addonFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

/**
 * What an add-on writes for one provider: whole files it owns, and optionally one block of
 * instructions inside a shared file such as `CLAUDE.md`, which it never touches outside its block.
 */
export const addonInstallPayloadSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  providerId: z.string(),
  files: z.array(addonFileSchema),
  instructions: addonFileSchema.optional(),
});

/** `edited` means the file or block changed since Maestro wrote it. */
export const addonPartStateSchema = z.enum(['intact', 'edited', 'missing']);

export const installedAddonSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  providerId: z.string(),
  /** Absolute config folder the add-on was installed into. */
  root: z.string(),
  installedAt: z.string(),
  files: z.array(z.object({ path: z.string(), state: addonPartStateSchema })),
  instructions: z.object({ path: z.string(), state: addonPartStateSchema }).optional(),
});

export const installedAddonsSchema = z.array(installedAddonSchema);

export const authPendingUrlSchema = z.object({
  id: z.string(),
  url: z.url(),
});

export const authLoginStateSchema = z.object({
  methodId: z.string(),
  startedAt: z.number(),
  pendingUrl: authPendingUrlSchema.nullable(),
  exit: z
    .object({
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
    })
    .nullable(),
});

export const authStatusModelStateSchema = z.object({
  status: agentAuthStatusSchema,
  login: authLoginStateSchema.nullable(),
});

export const agentConfigEntrySchema = z.object({
  providerId: z.string(),
  name: z.string(),
  auth: authStatusModelStateSchema,
});

export const agentConfigListSchema = z.record(z.string(), agentConfigEntrySchema);

export const hooksStatusSchema = z.object({
  state: z.enum(['installed', 'pending-install']),
  resolvedRoot: z.string(),
});

export const startLoginCommandSchema = z.object({
  providerId: z.string(),
  methodId: z.string(),
  // Initial PTY grid, measured by the client's terminal before the login
  // starts. Optional for back-compat; the runtime falls back to its defaults.
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

export const providerCommandSchema = z.object({ providerId: z.string() });
export const sendLoginInputCommandSchema = providerCommandSchema.extend({ data: z.string() });
export const resizeLoginCommandSchema = providerCommandSchema.extend({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const markUrlHandledCommandSchema = providerCommandSchema.extend({ urlId: z.string() });

export const mcpServerListSchema = z.array(mcpServerSchema);
export const installedSkillsSchema = z.array(catalogSkillSchema);
export { createSkillInputSchema, mcpServerSchema, skillInstallPayloadSchema };

export type AgentConfigError = z.infer<typeof agentConfigErrorSchema>;
export type AgentConfigAuthError = z.infer<typeof agentConfigAuthErrorSchema>;
export type AgentConfigMcpError = z.infer<typeof agentConfigMcpErrorSchema>;
export type AgentConfigSkillsError = z.infer<typeof agentConfigSkillsErrorSchema>;
export type AgentConfigAddonsError = z.infer<typeof agentConfigAddonsErrorSchema>;
export type AddonInstallPayload = z.infer<typeof addonInstallPayloadSchema>;
export type AddonPartState = z.infer<typeof addonPartStateSchema>;
export type InstalledAddon = z.infer<typeof installedAddonSchema>;
export type AuthStatusModelState = z.infer<typeof authStatusModelStateSchema>;
export type AuthLoginState = z.infer<typeof authLoginStateSchema>;
export type AuthPendingUrl = z.infer<typeof authPendingUrlSchema>;
export type AgentConfigEntry = z.infer<typeof agentConfigEntrySchema>;
export type AgentConfigList = z.infer<typeof agentConfigListSchema>;
export type HooksStatus = z.infer<typeof hooksStatusSchema>;
