import type Anthropic from '@anthropic-ai/sdk';
import { defineContract, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const conductorDomain = 'conductor' as const;

export const conductorModeSchema = z.enum(['command', 'plan']);
export type ConductorMode = z.infer<typeof conductorModeSchema>;

export const conductorEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const conductorSettingsSchema = z.object({
  /** Claude model for the conductor. */
  model: z.string(),
  /** Model the API retries on when the primary declines (server-side fallback). */
  fallbackModel: z.string(),
  /** Effort for quick voice commands (latency-sensitive). */
  commandEffort: conductorEffortSchema,
  /** Effort for decomposing goals into parallel agent plans. */
  planEffort: conductorEffortSchema,
  /** Spawn planned agents without waiting for an explicit approval. */
  autoApprovePlans: z.boolean(),
  /** Upper bound on agents one plan may start. */
  maxAgentsPerPlan: z.number().int().min(1).max(12),
  /** Daily conductor token budget (input + output); 0 disables the guard. */
  dailyTokenBudget: z.number().int().min(0),
});
export type ConductorSettings = z.infer<typeof conductorSettingsSchema>;

export const DEFAULT_CONDUCTOR_SETTINGS: ConductorSettings = {
  model: 'claude-opus-5',
  fallbackModel: 'claude-opus-4-8',
  commandEffort: 'low',
  planEffort: 'high',
  autoApprovePlans: false,
  maxAgentsPerPlan: 4,
  dailyTokenBudget: 3_000_000,
};

export const conductorUsageSchema = z.object({
  day: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
});
export type ConductorUsage = z.infer<typeof conductorUsageSchema>;

export const conductorStatusSchema = z.object({
  configured: z.boolean(),
  settings: conductorSettingsSchema,
  usageToday: conductorUsageSchema,
});
export type ConductorStatus = z.infer<typeof conductorStatusSchema>;

export const conductorTurnResultSchema = z.object({
  content: z.custom<Anthropic.Beta.BetaContentBlock[]>(),
  stopReason: z.string().nullable(),
  model: z.string(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
  }),
});
export type ConductorTurnResult = z.infer<typeof conductorTurnResultSchema>;

export const conductorErrorSchema = z.object({
  type: z.enum(['not-configured', 'budget-exceeded', 'rate-limited', 'refused', 'api-error']),
  message: z.string(),
});
export type ConductorError = z.infer<typeof conductorErrorSchema>;

export const conflictReportSchema = z.object({
  pairs: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      conflicted: z.boolean(),
      files: z.array(z.string()),
    })
  ),
});
export type ConflictReport = z.infer<typeof conflictReportSchema>;

export const conductorTurnRecordSchema = z.object({
  at: z.string(),
  utterance: z.string(),
  route: z.enum(['grammar', 'llm']),
  actions: z.array(z.object({ tool: z.string(), input: z.unknown(), outcome: z.string() })),
  reply: z.string(),
  latencyMs: z.number(),
  tokens: z.number().optional(),
});
export type ConductorTurnRecord = z.infer<typeof conductorTurnRecordSchema>;

export const conductorContract = defineContract({
  runTurn: fallible({
    input: z.object({
      mode: conductorModeSchema,
      messages: z.custom<Anthropic.Beta.BetaMessageParam[]>(),
    }),
    data: conductorTurnResultSchema,
    error: conductorErrorSchema,
  }),
  getStatus: procedure({ input: z.void(), output: conductorStatusSchema }),
  updateSettings: procedure({
    input: conductorSettingsSchema.partial(),
    output: conductorStatusSchema,
  }),
  /** Predicts merge conflicts between worktrees of one repository (read-only `git merge-tree`). */
  checkConflicts: fallible({
    input: z.object({
      worktrees: z
        .array(z.object({ label: z.string(), path: z.string() }))
        .min(2)
        .max(12),
    }),
    data: conflictReportSchema,
    error: z.object({ message: z.string() }),
  }),
  appendLog: procedure({ input: conductorTurnRecordSchema, output: z.void() }),
  readLog: procedure({
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(conductorTurnRecordSchema),
  }),
});

export type ConductorContract = typeof conductorContract;
