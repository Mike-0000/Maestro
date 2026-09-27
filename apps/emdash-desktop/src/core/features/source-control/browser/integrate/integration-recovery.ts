import {
  describeIntegrationBlocker,
  shortName,
  type IntegrationBlocker,
  type IntegrationPreview,
  type LocalBranchRef,
} from '@emdash/core/runtimes/git/api';
import { resolveTaskBranchName, type CreateTaskParams } from '@core/primitives/tasks/api';

/**
 * The Chorus self-update coordinator owns this branch; integrating task work straight into it
 * would bypass the candidate/validate/promote pipeline behind "Update Chorus".
 */
export const COORDINATOR_MANAGED_BRANCH = 'refs/heads/chorus/main';

export const RESOLUTION_AGENT_PROVIDER = 'claude';

export type IntegrationFailure = {
  /** Why the automatic integration could not finish; shown to the user and the agent. */
  reason: string;
  conflictedFiles: readonly string[];
};

export type ResolutionPlan = {
  taskName: string;
  branchName: string;
  /** Short name of the local branch the resolution worktree starts from. */
  fromBranch: string;
  prompt: string;
  /** Shell steps for resolving by hand when no agent can run. */
  manualSteps: string[];
};

export type ResolutionPlanInput = {
  sourceTaskName: string;
  sourceBranch: LocalBranchRef | null;
  sourceHead: string;
  targetBranch: LocalBranchRef;
  targetHead: string;
  failure: IntegrationFailure;
  branchPrefix: string;
  suffix: string;
};

/** User-facing blockers, including the Chorus coordinator guard the host runtime does not know. */
export function integrationBlockers(preview: IntegrationPreview): string[] {
  const messages = preview.blockers.map((blocker) => describeBlocker(blocker, preview));
  if (preview.target.branch === COORDINATOR_MANAGED_BRANCH) {
    messages.unshift(
      'The main directory is on chorus/main, which Update Chorus manages. Use Update Chorus to ' +
        'deliver this task instead.'
    );
  }
  return messages;
}

function describeBlocker(blocker: IntegrationBlocker, preview: IntegrationPreview): string {
  if (blocker.kind !== 'local-changes') return describeIntegrationBlocker(blocker);
  const listed = blocker.paths.slice(0, 5).join(', ');
  const more = blocker.paths.length > 5 ? ` and ${blocker.paths.length - 5} more` : '';
  const target = preview.target.branch ? shortName(preview.target.branch) : 'the main directory';
  return (
    `Uncommitted changes in the main directory (${listed}${more}) would be overwritten. ` +
    `Commit or discard them in the main directory, then integrate into ${target}.`
  );
}

/** One-line summary of what integrating will do. */
export function describeIntegrationPlan(preview: IntegrationPreview): string {
  const target = preview.target.branch ? shortName(preview.target.branch) : 'the main directory';
  const commits = pluralize(preview.ahead, 'commit');
  switch (preview.mode) {
    case 'up-to-date':
      return `Everything committed on this task is already in ${target}.`;
    case 'fast-forward':
      return `${target} will fast-forward by ${commits}.`;
    case 'merge':
      return (
        `${target} has ${pluralize(preview.behind, 'commit')} this task doesn't. A merge commit ` +
        `bringing in ${commits} will be created off to the side, then ${target} fast-forwards to it.`
      );
    case 'conflict':
      return (
        `Merging ${commits} into ${target} conflicts in ` +
        `${pluralize(preview.conflictedFiles.length, 'file')}. Nothing will be changed in the ` +
        'main directory; the conflict can be resolved in a separate task.'
      );
    case null:
      return 'This task cannot be integrated right now.';
  }
}

export function resolutionTaskName(sourceTaskName: string): string {
  return `Resolve ${sourceTaskName} integration`.slice(0, 80);
}

export function slugForBranch(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export function buildResolutionPlan(input: ResolutionPlanInput): ResolutionPlan {
  const fromBranch = shortName(input.targetBranch);
  const branchName = resolveTaskBranchName({
    rawBranch: `resolve-${slugForBranch(input.sourceTaskName)}`,
    branchPrefix: input.branchPrefix,
    suffix: input.suffix,
    appendRandomSuffix: true,
  });
  const source = input.sourceBranch
    ? `branch \`${shortName(input.sourceBranch)}\` at commit ${input.sourceHead}`
    : `commit ${input.sourceHead}`;
  const mergeCommand = `git merge --no-ff --no-edit ${input.sourceHead}`;
  const files = input.failure.conflictedFiles;
  const fileList = files.length
    ? `Files expected to conflict:\n${files.map((file) => `- ${file}`).join('\n')}`
    : 'Git did not report specific conflicted files; inspect the merge output.';

  const prompt = [
    `Chorus tried to integrate the task "${input.sourceTaskName}" (${source}) into ` +
      `\`${fromBranch}\` and could not finish automatically.`,
    `Reason: ${input.failure.reason}`,
    '',
    `You are in a new, isolated worktree on branch \`${branchName}\`, created from ` +
      `\`${fromBranch}\` (main was at ${input.targetHead} when integration was attempted).`,
    '',
    'Resolve the integration here:',
    `1. Run \`${mergeCommand}\`.`,
    '2. Resolve every conflict, preserving the intent of both sides. If the right resolution is ' +
      'unclear, stop and ask me instead of guessing.',
    "3. Run the project's relevant checks or tests for the files you touched.",
    '4. Commit the completed merge in this worktree.',
    '',
    fileList,
    '',
    'Safety rules:',
    '- Work only in this worktree. Do not modify, reset, or check out anything in the original ' +
      "task's worktree or in the project's main directory.",
    '- Do not push, force-push, rebase, or rewrite history, and do not delete branches.',
    '',
    'When you are done, summarize how each conflict was resolved and anything that needs my ' +
      `review. I will review this task and use Integrate on it to bring the result into ` +
      `\`${fromBranch}\`.`,
  ].join('\n');

  return {
    taskName: resolutionTaskName(input.sourceTaskName),
    branchName,
    fromBranch,
    prompt,
    manualSteps: [
      `git switch -c ${branchName} ${fromBranch}`,
      mergeCommand,
      '# resolve conflicts, run checks, then:',
      'git commit',
    ],
  };
}

export function buildResolutionTaskParams(
  projectId: string,
  plan: ResolutionPlan,
  agent: { initialPromptSupported: boolean } | null
): CreateTaskParams {
  return {
    id: crypto.randomUUID(),
    projectId,
    taskConfig: {
      version: '1',
      name: plan.taskName,
      initialConversation: agent
        ? {
            id: crypto.randomUUID(),
            provider: RESOLUTION_AGENT_PROVIDER,
            title: 'Resolve integration',
            ...(agent.initialPromptSupported && { initialPrompt: plan.prompt }),
            // The agent must ask before running commands; nothing it does is auto-approved.
            autoApprove: false,
            type: 'pty',
          }
        : undefined,
    },
    workspaceConfig: {
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: plan.branchName,
        fromBranch: { type: 'local', branch: plan.fromBranch },
        pushBranch: false,
      },
      workspace: { kind: 'new-worktree' },
    },
  };
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
