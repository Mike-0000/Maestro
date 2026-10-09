import type Anthropic from '@anthropic-ai/sdk';
import { defineContract, fallible, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { jevAnswerSchema, type JevQuestions } from './jev';

export const conductorDomain = 'conductor' as const;

export const conductorModeSchema = z.enum(['command', 'plan']);
export type ConductorMode = z.infer<typeof conductorModeSchema>;

export const conductorEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const conductorProviderSchema = z.enum(['anthropic', 'openrouter']);
export type ConductorProvider = z.infer<typeof conductorProviderSchema>;

export const conductorSettingsSchema = z.object({
  /** Where the conductor's model runs: the Anthropic API directly, or OpenRouter. */
  provider: conductorProviderSchema,
  /** Claude model for the conductor. */
  model: z.string(),
  /** OpenRouter model id used when provider is openrouter. */
  openrouterModel: z.string(),
  /** Model the API retries on when the primary declines (server-side fallback). */
  fallbackModel: z.string(),
  /** Effort for quick voice commands (latency-sensitive). */
  commandEffort: conductorEffortSchema,
  /** Effort for decomposing goals into parallel agent plans. */
  planEffort: conductorEffortSchema,
  /** Spawn planned agents without waiting for an explicit approval. */
  autoApprovePlans: z.boolean(),
  /**
   * When an agent finishes with a final reply, let the model read it to narrate what the agent
   * reported and take follow-ups the user asked for (opening its app). Off: a fixed sentence.
   */
  completionFollowUp: z.boolean(),
  /** Upper bound on agents one plan may start. */
  maxAgentsPerPlan: z.number().int().min(1).max(12),
  /** Daily conductor token budget (input + output); 0 disables the guard. */
  dailyTokenBudget: z.number().int().min(0),
  /** Use Jev (TypeSafe AI) for fast routing, risk, urgency, and plan-review decisions. */
  jevEnabled: z.boolean(),
  /**
   * Where Jev runs: OpenRouter's System One API (OpenRouter key), TypeSafe's API (TypeSafe key), or
   * auto (whichever key is set; OpenRouter first when the conductor uses OpenRouter).
   */
  jevSource: z.enum(['auto', 'openrouter', 'typesafe']),
  /** Minimum Jev confidence before the conductor acts on a decision without Claude. */
  jevConfidence: z.number().min(0.5).max(0.99),
  /**
   * Fast verbatim routing: when Jev is confident, it sends the developer's own words to an agent
   * or starts an agent directly (behind the usual cancel window) instead of Claude rewriting them.
   */
  jevVerbatimRouting: z.boolean(),
  /** Local diagnostic traces are disabled until the user explicitly opts in. */
  diagnosticHistory: z.boolean(),
  diagnosticDays: z.number().int().min(1).max(30),
});
export type ConductorSettings = z.infer<typeof conductorSettingsSchema>;

export const DEFAULT_CONDUCTOR_SETTINGS: ConductorSettings = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  openrouterModel: 'anthropic/claude-opus-5',
  fallbackModel: 'claude-opus-4-8',
  commandEffort: 'low',
  planEffort: 'high',
  autoApprovePlans: false,
  completionFollowUp: true,
  maxAgentsPerPlan: 4,
  dailyTokenBudget: 3_000_000,
  jevEnabled: true,
  jevSource: 'auto',
  jevConfidence: 0.8,
  jevVerbatimRouting: true,
  diagnosticHistory: false,
  diagnosticDays: 7,
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
  /** Jev is enabled and a key for its source is available. */
  jevReady: z.boolean(),
  /** Where Jev requests go right now (null when Jev is off or has no key). */
  jevVia: z.enum(['openrouter', 'typesafe']).nullable(),
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
  route: z.enum(['grammar', 'jev', 'llm']),
  actions: z.array(
    z.object({
      tool: z.string(),
      input: z.unknown(),
      outcome: z.string(),
      /** Set when the action did not happen: it failed, or the user cancelled it. */
      status: z.enum(['failed', 'cancelled']).optional(),
    })
  ),
  reply: z.string(),
  latencyMs: z.number(),
  tokens: z.number().optional(),
});
export type ConductorTurnRecord = z.infer<typeof conductorTurnRecordSchema>;

export const traceEventSchema = z.object({
  interactionId: z.string().uuid(),
  at: z.string().datetime(),
  kind: z.enum([
    'capture',
    'stt-partial',
    'stt-final',
    'stt-failed',
    'ignored',
    'dictation',
    'route',
    'confirmation',
    'tool-start',
    'tool-result',
    'action-result',
    'reply',
    'speech',
    /** One Jev evaluation: its purpose, answers, latency, decision, or why it was skipped. */
    'jev',
  ]),
  /** Bounded, redacted text. Raw audio and model messages are never stored. */
  text: z.string().max(4000).optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

export const systemChecksSchema = z.object({
  platform: z.string(),
  git: z.boolean(),
  /** Whether git's global core.longpaths is on; null when not applicable (non-Windows, no git). */
  longPaths: z.boolean().nullable(),
});
export type SystemChecks = z.infer<typeof systemChecksSchema>;

export const jevDecisionSchema = z.object({
  answers: z.record(z.string(), jevAnswerSchema),
  model: z.string(),
  latencyMs: z.number(),
  via: z.enum(['openrouter', 'typesafe']),
  /** USD cost when the source reports it (OpenRouter does). */
  costUsd: z.number().optional(),
});
export type JevDecision = z.infer<typeof jevDecisionSchema>;

export const jevErrorSchema = z.object({
  type: z.enum(['not-configured', 'disabled', 'rate-limited', 'api-error']),
  message: z.string(),
});
export type JevError = z.infer<typeof jevErrorSchema>;

export const conductorContract = defineContract({
  /** One Jev (System One) evaluation: typed questions about a state, answered in parallel. */
  decide: fallible({
    input: z.object({
      state: z.unknown(),
      questions: z.custom<JevQuestions>(),
    }),
    data: jevDecisionSchema,
    error: jevErrorSchema,
  }),
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
  appendTrace: procedure({ input: traceEventSchema, output: z.void() }),
  readTrace: procedure({
    input: z.object({
      interactionId: z.string().uuid().optional(),
      since: z.string().datetime().optional(),
      before: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(200),
    }),
    output: z.array(traceEventSchema),
  }),
  deleteDiagnostics: procedure({ input: z.void(), output: z.void() }),
  getSystemChecks: procedure({ input: z.void(), output: systemChecksSchema }),
  /** Layout, scripts, README head, and hot spots of a local repository, for planning. */
  projectContext: procedure({
    input: z.object({ path: z.string() }),
    output: z.object({ text: z.string().nullable() }),
  }),
  /** Runs `git config --global core.longpaths true`; only called from an explicit user click. */
  enableGitLongPaths: procedure({ input: z.void(), output: systemChecksSchema }),
  readLog: procedure({
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(conductorTurnRecordSchema),
  }),
});

export type ConductorContract = typeof conductorContract;
