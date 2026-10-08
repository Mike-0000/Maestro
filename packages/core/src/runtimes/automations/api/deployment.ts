import { z } from 'zod';
import { hostAbsolutePathSchema, hostFileRefSchema } from '#primitives/path/api';
import {
  acpSessionLaunchInputSchema,
  tuiSessionStartInputSchema,
} from '#services/session-start/api';

const nonBlankStringSchema = z.string().trim().min(1);

export const automationIdSchema = z.string().min(1);

export const automationGitRemoteSchema = z.object({
  name: nonBlankStringSchema,
  url: nonBlankStringSchema,
});

export const automationGitBranchRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    branch: nonBlankStringSchema,
    remote: automationGitRemoteSchema.optional(),
  }),
  z.object({
    type: z.literal('remote'),
    branch: nonBlankStringSchema,
    remote: automationGitRemoteSchema,
  }),
]);

export const automationWorktreeConfigSchema = z.object({
  kind: z.literal('worktree'),
  repository: hostFileRefSchema,
  worktreePoolPath: hostAbsolutePathSchema,
  baseRemote: nonBlankStringSchema,
  preservePatterns: z.array(nonBlankStringSchema),
  git: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('create-branch'),
      fromBranch: automationGitBranchRefSchema,
      pushRemote: nonBlankStringSchema.nullable(),
    }),
    z.object({
      kind: z.literal('use-branch'),
      branchName: nonBlankStringSchema,
    }),
  ]),
});

export const automationDirectoryConfigSchema = z.object({
  kind: z.literal('directory'),
  path: hostFileRefSchema,
});

export const automationWorkspaceConfigSchema = z.discriminatedUnion('kind', [
  automationWorktreeConfigSchema,
  automationDirectoryConfigSchema,
]);

export const automationScheduleSchema = z.object({
  expr: z.string().trim().min(1),
  tz: z.string().trim().min(1),
});

export const automationAcpAgentConfigSchema = z.object({
  type: z.literal('acp'),
  start: acpSessionLaunchInputSchema.omit({
    conversationId: true,
    cwd: true,
    sessionId: true,
  }),
  title: nonBlankStringSchema.optional(),
});

export const automationTuiAgentConfigSchema = z.object({
  type: z.literal('tui'),
  start: tuiSessionStartInputSchema.omit({
    conversationId: true,
    cwd: true,
    sessionId: true,
    cols: true,
    rows: true,
  }),
  title: nonBlankStringSchema.optional(),
});

export const automationAgentConfigSchema = z.discriminatedUnion('type', [
  automationAcpAgentConfigSchema,
  automationTuiAgentConfigSchema,
]);

/**
 * Which triggers start runs. Absent means cron-scheduled (the original behaviour);
 * `cron: false` makes the automation on-demand only (`startRun`).
 */
export const automationTriggersSchema = z.object({
  cron: z.boolean(),
});

export const AUTOMATION_COMPLETION_DEFAULT_TIMEOUT_MS = 60 * 60_000;

/**
 * Post-session delivery. When present, a run keeps its worker slot after the session
 * starts, waits for the agent to settle, then pushes the run branch and opens a pull
 * request against `baseBranch`. Nothing merges automatically.
 */
export const automationCompletionSchema = z.object({
  kind: z.literal('pull-request'),
  baseBranch: nonBlankStringSchema,
  remote: nonBlankStringSchema,
  timeoutMs: z.number().int().positive().optional(),
});

export const automationDeploymentSchema = z.object({
  automationId: automationIdSchema,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  name: nonBlankStringSchema,
  schedule: automationScheduleSchema,
  agent: automationAgentConfigSchema,
  workspace: automationWorkspaceConfigSchema,
  triggers: automationTriggersSchema.optional(),
  /** Runs of this automation allowed in flight at once. Absent means 1. */
  maxConcurrentRuns: z.number().int().positive().optional(),
  completion: automationCompletionSchema.optional(),
});

export const automationRunConfigSnapshotSchema = automationDeploymentSchema.pick({
  name: true,
  schedule: true,
  agent: true,
  workspace: true,
  completion: true,
});

export type AutomationId = z.infer<typeof automationIdSchema>;
export type AutomationGitRemote = z.infer<typeof automationGitRemoteSchema>;
export type AutomationGitBranchRef = z.infer<typeof automationGitBranchRefSchema>;
export type AutomationWorktreeConfig = z.infer<typeof automationWorktreeConfigSchema>;
export type AutomationDirectoryConfig = z.infer<typeof automationDirectoryConfigSchema>;
export type AutomationWorkspaceConfig = z.infer<typeof automationWorkspaceConfigSchema>;
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;
export type AutomationAcpAgentConfig = z.infer<typeof automationAcpAgentConfigSchema>;
export type AutomationTuiAgentConfig = z.infer<typeof automationTuiAgentConfigSchema>;
export type AutomationAgentConfig = z.infer<typeof automationAgentConfigSchema>;
export type AutomationTriggers = z.infer<typeof automationTriggersSchema>;
export type AutomationCompletion = z.infer<typeof automationCompletionSchema>;
export type AutomationDeployment = z.infer<typeof automationDeploymentSchema>;
export type AutomationRunConfigSnapshot = z.infer<typeof automationRunConfigSnapshotSchema>;
