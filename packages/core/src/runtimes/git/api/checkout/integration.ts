import { z } from 'zod';
import { hostAbsolutePathSchema } from '#primitives/path/api';
import { gitFilePathSchema } from '#runtimes/git/api/checkout/schemas';
import {
  checkoutOperationSchema,
  checkoutStatusSummarySchema,
} from '#runtimes/git/api/checkout/states/status';
import {
  conflictErrorSchema,
  gitExecErrorSchema,
  gitResolutionErrorSchema,
} from '#runtimes/git/api/errors';
import { localBranchRefSchema } from '#runtimes/git/api/repository/states/refs';
import { checkoutSelectorSchema } from '#runtimes/git/api/selectors';

/**
 * Integrating one checkout's committed work (the source, usually a task worktree) into
 * the branch checked out by another checkout of the same repository (the target,
 * usually the project's main directory).
 *
 * The merge result is computed off-tree and the target checkout is only ever
 * fast-forwarded, so a failed integration never leaves the target mid-merge.
 */
export const integrationInputSchema = checkoutSelectorSchema.extend({
  /** The checkout whose committed HEAD is integrated. */
  source: hostAbsolutePathSchema,
});
export type IntegrationInput = z.infer<typeof integrationInputSchema>;

/** What an integration would do, derived from the current target and source commits. */
export const integrationModeSchema = z.enum(['up-to-date', 'fast-forward', 'merge', 'conflict']);
export type IntegrationMode = z.infer<typeof integrationModeSchema>;

/** Conditions that make an integration unsafe to run right now. */
export const integrationBlockerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('target-not-on-branch') }),
  z.object({ kind: z.literal('target-operation'), operation: checkoutOperationSchema }),
  z.object({ kind: z.literal('source-not-committed') }),
  z.object({ kind: z.literal('source-operation'), operation: checkoutOperationSchema }),
  z.object({ kind: z.literal('same-checkout') }),
  z.object({ kind: z.literal('different-repository') }),
  z.object({ kind: z.literal('same-branch') }),
  z.object({ kind: z.literal('unrelated-histories') }),
  z.object({ kind: z.literal('merge-unsupported'), message: z.string() }),
  z.object({ kind: z.literal('local-changes'), paths: z.array(gitFilePathSchema) }),
]);
export type IntegrationBlocker = z.infer<typeof integrationBlockerSchema>;

/** A user-facing sentence for an integration blocker. */
export function describeIntegrationBlocker(blocker: IntegrationBlocker): string {
  switch (blocker.kind) {
    case 'target-not-on-branch':
      return 'The main directory is not on a branch.';
    case 'target-operation':
      return `The main directory has a ${blocker.operation} in progress.`;
    case 'source-not-committed':
      return 'The task has no commits to integrate.';
    case 'source-operation':
      return `The task worktree has a ${blocker.operation} in progress.`;
    case 'same-checkout':
      return 'The task already runs in the main directory.';
    case 'different-repository':
      return 'The task worktree belongs to a different repository.';
    case 'same-branch':
      return 'The task and the main directory use the same branch.';
    case 'unrelated-histories':
      return 'The task branch does not share history with the main directory branch.';
    case 'merge-unsupported':
      return blocker.message;
    case 'local-changes':
      return 'Uncommitted changes in the main directory touch files this integration changes.';
  }
}

export const integrationCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
});
export type IntegrationCommit = z.infer<typeof integrationCommitSchema>;

export const integrationPreviewSchema = z.object({
  target: z.object({
    /** Null when the target is detached or unborn (always paired with a blocker). */
    branch: localBranchRefSchema.nullable(),
    head: z.string().nullable(),
    /** Summary of uncommitted changes in the target checkout. */
    changes: checkoutStatusSummarySchema.nullable(),
  }),
  source: z.object({
    branch: localBranchRefSchema.nullable(),
    head: z.string().nullable(),
    /** Uncommitted source work is never integrated; surfaced so callers can commit first. */
    changes: checkoutStatusSummarySchema.nullable(),
  }),
  mode: integrationModeSchema.nullable(),
  /** Commits reachable from the source but not the target. */
  ahead: z.number().int().nonnegative(),
  /** Commits reachable from the target but not the source. */
  behind: z.number().int().nonnegative(),
  /** Newest-first sample of the incoming commits. */
  commits: z.array(integrationCommitSchema),
  /** Files whose content changes in the target when integrated. */
  changedFiles: z.array(gitFilePathSchema),
  conflictedFiles: z.array(gitFilePathSchema),
  blockers: z.array(integrationBlockerSchema),
});
export type IntegrationPreview = z.infer<typeof integrationPreviewSchema>;

export const integrateInputSchema = integrationInputSchema.extend({
  /** The target HEAD the caller previewed; a moved target refuses instead of integrating. */
  expectedTargetHead: z.string().min(1),
  /** The source HEAD the caller previewed; new source commits refuse instead of riding along. */
  expectedSourceHead: z.string().min(1),
  /** Merge commit message when the integration cannot fast-forward. */
  message: z.string().optional(),
});
export type IntegrateInput = z.infer<typeof integrateInputSchema>;

export const integrateResultSchema = z.object({
  mode: z.enum(['up-to-date', 'fast-forward', 'merge']),
  branch: localBranchRefSchema,
  previousHead: z.string(),
  /** The target branch's new HEAD. */
  commit: z.string(),
});
export type IntegrateResult = z.infer<typeof integrateResultSchema>;

const messageError = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), message: z.string() });

export const integrateErrorSchema = z.discriminatedUnion('type', [
  conflictErrorSchema,
  messageError('target_moved'),
  messageError('source_moved'),
  z.object({
    type: z.literal('blocked'),
    message: z.string(),
    blocker: integrationBlockerSchema,
  }),
  z.object({
    type: z.literal('local_changes'),
    message: z.string(),
    paths: z.array(gitFilePathSchema),
  }),
  gitExecErrorSchema,
  gitResolutionErrorSchema,
]);
export type IntegrateError = z.infer<typeof integrateErrorSchema>;
