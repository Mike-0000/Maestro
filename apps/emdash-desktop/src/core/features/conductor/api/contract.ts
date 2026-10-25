import type Anthropic from '@anthropic-ai/sdk';
import { defineContract, eventStream, fallible, liveJob, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { agentRequestAckSchema, agentRequestSchema } from './agent-requests';
import { completionAnnouncementModes } from './announcements';
import { callModes, DEFAULT_CALL_WINDOW_SEC } from './calls';
import { jevAnswerSchema, type JevQuestions } from './jev';
import { instructionChangeSchema, standingInstructionSchema } from './standing-instructions';

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
  /**
   * Let agents send requests to the conductor (start another agent, message one, ask the
   * developer, report). Off: every request is refused when it arrives.
   */
  agentRequests: z.boolean(),
  /**
   * When an agent ends a turn, the conductor's model reads its final reply and decides whether
   * the agent needs the developer or is done. Off: hook events alone decide, as before.
   */
  attentionVerdicts: z.boolean(),
  /**
   * Which finished agents reach the developer: all of them, or only those that need the developer
   * (attention_only). In attention_only, a finished agent with nothing for the developer stays on
   * the HUD: it is not spoken, and its notification sound, desktop notification and phone push are
   * dropped. It takes effect only while attention verdicts run, since they tell the two apart.
   */
  announceCompletions: z.enum(completionAnnouncementModes),
  /**
   * Calls: what agents need reaches the developer one caller at a time, and what the developer
   * says after picking a call up goes to that caller. off keeps the batched announcements,
   * quiet shows calls without speaking them, spoken reads them aloud.
   */
  calls: z.enum(callModes),
  /** Seconds a call stays on the line after it was delivered. */
  callWindowSec: z.number().int().min(2).max(30),
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
   * or starts an agent directly instead of Claude rewriting them.
   */
  jevVerbatimRouting: z.boolean(),
  /** Local diagnostic traces are disabled until the user explicitly opts in. */
  diagnosticHistory: z.boolean(),
  diagnosticDays: z.number().int().min(1).max(30),
  /**
   * Code checks: let the conductor ask a read-only code scout (Claude Code, on the user's own
   * login) about a local project's files. Off by default: file contents go to Anthropic.
   */
  investigations: z.boolean(),
  /**
   * The scout's model: haiku, sonnet, or a model id. Deliberately any string here: a value this
   * schema refused would reset every conductor setting, so the name is checked when a scout starts.
   */
  investigatorModel: z.string(),
  /** Seconds one scout question may run. */
  investigationTimeoutSec: z.number().int().min(15).max(60),
  /** Scout questions allowed per day; 0 is no limit. */
  investigationsPerDay: z.number().int().min(0),
  /** Scout spend allowed per day in USD, as Claude Code reports it; 0 is no limit. */
  investigationDailyUsd: z.number().min(0),
  /** The one-time hint that offers code checks has been shown. */
  investigationOfferShown: z.boolean(),
  /**
   * Folders outside the project that a code check may also read, read-only, each chosen by the
   * developer. Any list of strings is accepted here, because a value this schema refused would
   * reset every conductor setting; the main process checks each folder before a check runs and
   * leaves out one it refuses (a drive root, the home folder, a hidden folder).
   */
  investigationFolders: z.array(z.string()),
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
  agentRequests: true,
  attentionVerdicts: true,
  announceCompletions: 'all',
  calls: 'off',
  callWindowSec: DEFAULT_CALL_WINDOW_SEC,
  maxAgentsPerPlan: 4,
  dailyTokenBudget: 3_000_000,
  jevEnabled: true,
  jevSource: 'auto',
  jevConfidence: 0.8,
  jevVerbatimRouting: true,
  diagnosticHistory: false,
  diagnosticDays: 7,
  investigations: false,
  investigatorModel: 'haiku',
  investigationTimeoutSec: 45,
  investigationsPerDay: 100,
  investigationDailyUsd: 2,
  investigationOfferShown: false,
  investigationFolders: [],
};

/**
 * Build-time switch for the code-checks settings group and its one-time hint. While it is false
 * the feature cannot be turned on from the app; the setting's own default stays off either way.
 */
export const CODE_CHECKS_UI: boolean = true;

export const conductorUsageSchema = z.object({
  day: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  /** Scout questions asked today. */
  investigations: z.number(),
  /** What Claude Code reported those questions (and self-tests) cost, in USD. */
  investigationCostUsd: z.number(),
});
export type ConductorUsage = z.infer<typeof conductorUsageSchema>;

/** Whether the conductor can run a code check right now, and why not when it cannot. */
export const investigatorStatusSchema = z.object({
  state: z.enum(['off', 'ready', 'unavailable']),
  reason: z.string().nullable(),
});
export type InvestigatorStatus = z.infer<typeof investigatorStatusSchema>;

export const conductorStatusSchema = z.object({
  configured: z.boolean(),
  /** Jev is enabled and a key for its source is available. */
  jevReady: z.boolean(),
  /** Where Jev requests go right now (null when Jev is off or has no key). */
  jevVia: z.enum(['openrouter', 'typesafe']).nullable(),
  settings: conductorSettingsSchema,
  usageToday: conductorUsageSchema,
  /** Test fixtures build a partial status, so read it as `status?.investigator?.state`. */
  investigator: investigatorStatusSchema,
  /**
   * What the developer told the conductor to do from now on, in the order it was saved. Test
   * fixtures build a partial status, so read it as `status?.instructions ?? []`.
   */
  instructions: z.array(standingInstructionSchema),
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
  /** 'line': the realtime talk line's model ran the turn, not the text conductor. */
  route: z.enum(['grammar', 'jev', 'llm', 'line']),
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
  /**
   * What the model itself answered, when that is not what was said (NO_NEWS, or nothing at all
   * from a turn that failed), so a log review can tell a quiet model from a failed one.
   */
  modelReply: z.string().optional(),
  /** Set when the model's turn did not complete (an error, a timeout, or no answer). */
  modelFailed: z.boolean().optional(),
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
    /** One model round trip: how long it took, its tokens, and why it stopped. */
    'model',
    /** A call from an agent: offered, spoken, picked up, skipped, or lapsed. */
    'call',
    /** A confirmation's clock paused because the developer started speaking, or resumed. */
    'hold',
    /** The realtime voice line: opened, closed, rolled over, or fell back. */
    'line',
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

/**
 * Size limits on a code check. The scout runner cuts every field to fit before it leaves the
 * main process, and the job's result schema below enforces the same numbers.
 */
export const INVESTIGATION_LIMITS = {
  questions: 3,
  questionChars: 400,
  answerChars: 1_500,
  evidenceItems: 5,
  pathChars: 300,
  quoteChars: 200,
  stepChars: 120,
} as const;

export const investigationFoundSchema = z.enum(['yes', 'no', 'unsure']);
export type InvestigationFound = z.infer<typeof investigationFoundSchema>;

export const investigationEvidenceSchema = z.object({
  path: z.string().max(INVESTIGATION_LIMITS.pathChars),
  line: z.number().int().positive().optional(),
  quote: z.string().max(INVESTIGATION_LIMITS.quoteChars),
  /** Whether the main process found the quote in that file. */
  found: z.boolean(),
});
export type InvestigationEvidence = z.infer<typeof investigationEvidenceSchema>;

export const investigationFailureReasonSchema = z.enum([
  'not-signed-in',
  'unsupported-cli',
  /** The CLI started with tools, servers or a mode other than the ones a scout may have. */
  'preflight',
  /** The CLI version has no recorded pass of the containment self-test. */
  'unverified-version',
  'not-found',
  'timeout',
  'cancelled',
  'budget',
  'rate-limited',
  'crashed',
  'bad-output',
]);
export type InvestigationFailureReason = z.infer<typeof investigationFailureReasonSchema>;

export const investigationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('answered'),
    question: z.string(),
    answer: z.string().max(INVESTIGATION_LIMITS.answerChars),
    found: investigationFoundSchema,
    evidence: z.array(investigationEvidenceSchema).max(INVESTIGATION_LIMITS.evidenceItems),
    durationMs: z.number(),
    costUsd: z.number(),
    /** Reads the scout attempted that its limits refused. */
    denied: z.number().int().min(0),
  }),
  z.object({
    status: z.literal('failed'),
    question: z.string(),
    reason: investigationFailureReasonSchema,
    message: z.string(),
    durationMs: z.number(),
  }),
]);
export type InvestigationOutcome = z.infer<typeof investigationOutcomeSchema>;

export const investigationInputSchema = z.object({
  /** An id, never a path: the main process resolves the folder and refuses remote hosts. */
  target: z.union([
    z.object({ projectId: z.string().min(1) }),
    z.object({ workspaceId: z.string().min(1) }),
  ]),
  questions: z
    .array(z.string().min(8).max(INVESTIGATION_LIMITS.questionChars))
    .min(1)
    .max(INVESTIGATION_LIMITS.questions),
});
export type InvestigationInput = z.infer<typeof investigationInputSchema>;

export const investigationProgressSchema = z.object({
  /** Which question, by its place in the input. */
  index: z.number().int().min(0),
  step: z.string().max(INVESTIGATION_LIMITS.stepChars),
});
export type InvestigationProgress = z.infer<typeof investigationProgressSchema>;

export const investigationResultSchema = z.object({
  model: z.string(),
  /** The folder the scout read, by its base name. The full path stays in the main process. */
  folderName: z.string(),
  outcomes: z.array(investigationOutcomeSchema).min(1).max(INVESTIGATION_LIMITS.questions),
  /** The developer's extra folders the scout could also read, by their base names. */
  alsoRead: z.array(z.string()).optional(),
  /**
   * `windows-copy`: the project lives in a WSL distro, and the scout read its live mirror on a
   * Windows drive, which holds the same files except ones git ignores.
   */
  source: z.enum(['project', 'windows-copy']).optional(),
});
export type InvestigationResult = z.infer<typeof investigationResultSchema>;

export const investigationErrorSchema = z.object({
  type: z.enum([
    'disabled',
    'unavailable',
    'daily-limit',
    'rate-limit',
    'not-found',
    'not-local',
    'failed',
  ]),
  message: z.string(),
});
export type InvestigationError = z.infer<typeof investigationErrorSchema>;

/** Size limits on a project lookup: names only, so the result stays small and file text stays out. */
export const LOOKUP_LIMITS = {
  terms: 5,
  termChars: 80,
  /** File paths whose name matches a term. */
  pathHits: 8,
  /** Files whose text mentions a term, most mentions first. */
  fileHits: 8,
} as const;

export const lookupInputSchema = z.object({
  /** An id, never a path: the main process resolves the folder on whichever host it lives. */
  target: investigationInputSchema.shape.target,
  terms: z
    .array(
      z
        .string()
        .trim()
        .min(2)
        .max(LOOKUP_LIMITS.termChars)
        .refine((term) => !/[\0\r\n]/u.test(term), 'A term is one line.')
    )
    .min(1)
    .max(LOOKUP_LIMITS.terms),
});
export type LookupInput = z.infer<typeof lookupInputSchema>;

export const lookupTermResultSchema = z.object({
  term: z.string(),
  /** Project-relative paths of files whose path contains the term. */
  paths: z.array(z.string()).max(LOOKUP_LIMITS.pathHits),
  /** Project-relative files whose text mentions the term, with how many lines do. */
  files: z
    .array(z.object({ path: z.string(), lines: z.number().int().min(1) }))
    .max(LOOKUP_LIMITS.fileHits),
  /** Every file whose text mentions the term, including those not listed. */
  filesTotal: z.number().int().min(0),
  /** False when the search stopped at its limit before reading every file. */
  complete: z.boolean(),
});
export type LookupTermResult = z.infer<typeof lookupTermResultSchema>;

export const lookupResultSchema = z.object({
  /** The folder searched, by its base name. */
  folderName: z.string(),
  terms: z.array(lookupTermResultSchema).min(1).max(LOOKUP_LIMITS.terms),
});
export type LookupResult = z.infer<typeof lookupResultSchema>;

export const lookupErrorSchema = z.object({
  type: z.enum(['disabled', 'not-found', 'failed']),
  message: z.string(),
});
export type LookupError = z.infer<typeof lookupErrorSchema>;

/** Whether a folder may be added to the code checks' extra folders, and as which real path. */
export const folderCheckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), path: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type FolderCheck = z.infer<typeof folderCheckSchema>;

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
  /**
   * Adds, replaces, removes or clears a standing instruction and returns the new status. Only
   * the conductor's own tool and the settings page call it, both in the developer's name.
   */
  adjustInstructions: fallible({
    input: instructionChangeSchema,
    data: z.object({ status: conductorStatusSchema, summary: z.string() }),
    error: z.object({ message: z.string() }),
  }),
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
  /** Requests agents send to the conductor through their session's MCP tool. */
  agentRequests: eventStream({ key: z.void(), event: agentRequestSchema }),
  /** The renderer's verdict on a request; the asking agent's tool call is waiting for it. */
  acknowledgeAgentRequest: procedure({
    input: z.object({ id: z.string(), ack: agentRequestAckSchema }),
    /** False when the tool call stopped waiting: the agent was told nothing happened. */
    output: z.object({ delivered: z.boolean() }),
  }),
  /**
   * A code check: a read-only scout answers up to three questions about a local project's files.
   * A live job because it runs for seconds and the developer can cancel it.
   */
  investigate: liveJob({
    input: investigationInputSchema,
    progress: investigationProgressSchema,
    result: investigationResultSchema,
    error: investigationErrorSchema,
  }),
  /**
   * Clears the scout's unavailable mark, resolves the CLI again, runs the containment self-test,
   * and returns the new status. It takes seconds: call it with `{ timeoutMs: 0 }`.
   */
  recheckInvestigator: procedure({ input: z.void(), output: conductorStatusSchema }),
  /**
   * A project lookup: where a name appears in a project's file paths and file text, on any host
   * (this computer, WSL, SSH). Names and counts only, never file contents. A live job because a
   * first search of a large or remote project can take seconds.
   */
  findInProject: liveJob({
    input: lookupInputSchema,
    progress: z.object({ done: z.number().int().min(0) }),
    result: lookupResultSchema,
    error: lookupErrorSchema,
  }),
  /** Checks a folder the developer wants code checks to read as well, before it is saved. */
  checkInvestigationFolder: procedure({
    input: z.object({ path: z.string() }),
    output: folderCheckSchema,
  }),
});

export type ConductorContract = typeof conductorContract;
