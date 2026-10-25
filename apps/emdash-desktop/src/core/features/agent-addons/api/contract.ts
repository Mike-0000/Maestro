import { hostRefSchema } from '@emdash/core/primitives/host/api';
import {
  agentConfigAddonsErrorSchema,
  installedAddonsSchema,
} from '@emdash/core/runtimes/agent-config/api';
import { runtimeResolveErrorSchema } from '@emdash/core/services/runtime-broker/api';
import { defineContract, fallible, liveModel, liveState, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

const hostInputSchema = z.object({ host: hostRefSchema });

/** What the settings page shows for one add-on: everything it would write, before install. */
export const addonCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  targets: z.array(
    z.object({
      providerId: z.string(),
      providerName: z.string(),
      files: z.array(z.string()),
      instructions: z.object({ path: z.string(), content: z.string() }).optional(),
    })
  ),
});

export const agentAddonsErrorSchema = z.union([
  agentConfigAddonsErrorSchema,
  runtimeResolveErrorSchema,
  z.object({ type: z.literal('unknown-addon'), addonId: z.string() }),
]);

export const agentAddonsDomain = 'agentAddons' as const;

export const agentAddonsContract = defineContract({
  catalog: procedure({
    input: z.void().optional(),
    output: z.array(addonCatalogEntrySchema),
  }),
  installed: liveModel({
    key: hostInputSchema,
    states: {
      list: liveState({ data: installedAddonsSchema }),
    },
  }),
  install: fallible({
    input: hostInputSchema.extend({ addonId: z.string(), replace: z.boolean().optional() }),
    data: z.object({ addons: installedAddonsSchema }),
    error: agentAddonsErrorSchema,
  }),
  remove: fallible({
    input: hostInputSchema.extend({ addonId: z.string() }),
    data: z.object({ addons: installedAddonsSchema }),
    error: agentAddonsErrorSchema,
  }),
});

export type AgentAddonsContract = typeof agentAddonsContract;
export type AddonCatalogEntry = z.infer<typeof addonCatalogEntrySchema>;
export type AgentAddonsError = z.infer<typeof agentAddonsErrorSchema>;
