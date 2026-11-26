import { defineVersionedSchema } from '@emdash/core/primitives/versioned-schema/api';
import z from 'zod';
import { taskConfig } from '@core/primitives/tasks/api';
import { workspaceConfig } from '@core/primitives/workspaces/api';

/**
 * On-demand automations ignore their schedule: runs start only when requested (from
 * the app or through a workspace server's trigger gateway), wait for the agent to
 * finish, and hand the result off as a pull request.
 */
export const onDemandTriggerSchema = z.object({
  maxConcurrentRuns: z.number().int().positive().optional(),
  timeoutMinutes: z.number().int().positive().optional(),
});

export const triggerConfigSchema = z.object({
  expr: z.string(),
  tz: z.string().optional(),
  onDemand: onDemandTriggerSchema.optional(),
});

export const DEFAULT_ON_DEMAND_MAX_CONCURRENT_RUNS = 2;

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const automationTriggerConfig = defineVersionedSchema()
  .unversioned(triggerConfigSchema)
  .build();

/** Runtime default for a close-when-done run with no timeout of its own (4 hours). */
export const DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES = 4 * 60;

/**
 * Close-when-done: each run waits for the agent to settle (or the timeout), then ends
 * the agent session. Such runs are unattended (no permission prompts). On-demand
 * automations ignore it, since they finish by opening a pull request.
 */
export const closeWhenDoneSchema = z.object({
  /** Absent means {@link DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES}. */
  timeoutMinutes: z.number().int().positive().optional(),
});

export type CloseWhenDoneConfig = z.infer<typeof closeWhenDoneSchema>;

export const conversationConfigSchema = z.object({
  prompt: z.string(),
  provider: z.string(),
  title: z.string().optional(),
  autoApprove: z.boolean(),
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model: z.string().optional(),
  /** Conversation transport: 'pty' for terminal or 'acp' for structured chat UI. */
  type: z.enum(['pty', 'acp']).optional(),
  /**
   * Effort id from the agent's `capabilities.effort.effortOptions`. Absent or empty
   * string means use the agent default.
   */
  effort: z.string().optional(),
  /** Absent means runs are left open when the agent finishes. */
  closeWhenDone: closeWhenDoneSchema.optional(),
});

export type ConversationConfig = z.infer<typeof conversationConfigSchema>;

export const automationConversationConfig = defineVersionedSchema()
  .unversioned(conversationConfigSchema)
  .build();

const storedAutomationTaskConfigV1Schema = z.object({
  version: z.literal('1'),
  taskConfig: taskConfig.asNested(),
  workspaceConfig: workspaceConfig.asNested(),
});

export const storedAutomationTaskConfig = defineVersionedSchema()
  .initial('1', storedAutomationTaskConfigV1Schema)
  .build();

export const storedAutomationTaskConfigSchema = storedAutomationTaskConfig.schema;
export type StoredAutomationTaskConfig = typeof storedAutomationTaskConfig.Type;
