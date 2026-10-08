import { z } from 'zod';
import { hostFileRefSchema } from '#primitives/path/api';
import { automationIdSchema, automationRunConfigSnapshotSchema } from './deployment';

const nonBlankStringSchema = z.string().trim().min(1);
const nullableTimestampSchema = z.number().int().nonnegative().nullable();

export const automationRunIdSchema = z.string().min(1);

export const automationRunStatuses = [
  'scheduled',
  'queued',
  'provisioning_workspace',
  'starting_session',
  'done',
  'failed',
  'skipped',
  'cancelled',
] as const;

export const automationRunStatusSchema = z.enum(automationRunStatuses);

export const automationRunTriggerKindSchema = z.enum(['cron', 'manual']);

export const automationRunErrorStepSchema = z.enum([
  'queue',
  'provision_workspace',
  'start_session',
  'run',
]);

export const automationRunErrorSchema = z.object({
  step: automationRunErrorStepSchema,
  code: nonBlankStringSchema,
  message: z.string().optional(),
});

/**
 * An externally submitted request that started the run. `id` is the caller's
 * idempotency key and doubles as the run id, so a repeated submission resolves to
 * the same run.
 */
export const automationRunRequestSchema = z.object({
  id: z.string().uuid(),
  title: nonBlankStringSchema.max(200),
  body: z.string().max(32_768),
  requester: z
    .object({ id: z.string().max(200), name: z.string().max(200) })
    .partial()
    .optional(),
  source: z
    .object({ app: z.string().max(200), url: z.string().max(2_000) })
    .partial()
    .optional(),
});

export const automationRunDeliveryStates = [
  'agent_running',
  'publishing',
  'pr_open',
  'pr_draft',
  'no_changes',
  'failed',
  'cancelled',
] as const;

export const automationRunDeliveryStateSchema = z.enum(automationRunDeliveryStates);

/** Post-session progress of a run whose automation has a `completion` config. */
export const automationRunDeliverySchema = z.object({
  state: automationRunDeliveryStateSchema,
  pullRequestUrl: z.string().nullable(),
  error: z.object({ code: nonBlankStringSchema, message: z.string().optional() }).nullable(),
  finishedAt: nullableTimestampSchema,
});

export const automationRunSchema = z.object({
  id: automationRunIdSchema,
  seq: z.number().int().positive(),
  automationId: automationIdSchema,
  status: automationRunStatusSchema,
  triggerKind: automationRunTriggerKindSchema,
  configSnapshot: automationRunConfigSnapshotSchema,
  generatedName: nonBlankStringSchema,
  scheduledAt: nullableTimestampSchema,
  deadlineAt: nullableTimestampSchema,
  startedAt: nullableTimestampSchema,
  finishedAt: nullableTimestampSchema,
  workspace: hostFileRefSchema.nullable(),
  branchName: nonBlankStringSchema.nullable(),
  conversationId: nonBlankStringSchema.nullable(),
  sessionId: nonBlankStringSchema.nullable(),
  error: automationRunErrorSchema.nullable(),
  request: automationRunRequestSchema.optional(),
  delivery: automationRunDeliverySchema.optional(),
});

export type AutomationRunId = z.infer<typeof automationRunIdSchema>;
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;
export type AutomationRunTriggerKind = z.infer<typeof automationRunTriggerKindSchema>;
export type AutomationRunErrorStep = z.infer<typeof automationRunErrorStepSchema>;
export type AutomationRunError = z.infer<typeof automationRunErrorSchema>;
export type AutomationRunRequest = z.infer<typeof automationRunRequestSchema>;
export type AutomationRunDeliveryState = z.infer<typeof automationRunDeliveryStateSchema>;
export type AutomationRunDelivery = z.infer<typeof automationRunDeliverySchema>;
export type AutomationRun = z.infer<typeof automationRunSchema>;
