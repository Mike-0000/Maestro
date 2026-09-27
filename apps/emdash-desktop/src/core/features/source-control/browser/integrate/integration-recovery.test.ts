import type { PortableRelativePath } from '@emdash/core/primitives/path/api';
import type { IntegrationPreview, LocalBranchRef } from '@emdash/core/runtimes/git/api';
import { describe, expect, it } from 'vitest';
import {
  buildResolutionPlan,
  buildResolutionTaskParams,
  describeIntegrationPlan,
  integrationBlockers,
  slugForBranch,
} from './integration-recovery';

const gitPath = (value: string) => value as PortableRelativePath;
const main = 'refs/heads/main' as LocalBranchRef;
const feature = 'refs/heads/emdash/feature-abc12' as LocalBranchRef;

function preview(overrides: Partial<IntegrationPreview> = {}): IntegrationPreview {
  return {
    target: { branch: main, head: 'aaa', changes: null },
    source: { branch: feature, head: 'bbb', changes: null },
    mode: 'fast-forward',
    ahead: 2,
    behind: 0,
    commits: [],
    changedFiles: [],
    conflictedFiles: [],
    blockers: [],
    ...overrides,
  };
}

const plan = buildResolutionPlan({
  sourceTaskName: 'Add Login Page!',
  sourceBranch: feature,
  sourceHead: 'bbbbbbbb',
  targetBranch: main,
  targetHead: 'aaaaaaaa',
  failure: { reason: 'Merge conflicts.', conflictedFiles: ['src/app.ts', 'README.md'] },
  branchPrefix: 'emdash',
  suffix: 'x1y2z',
});

describe('integration descriptions', () => {
  it('summarizes each integration mode', () => {
    expect(describeIntegrationPlan(preview())).toBe('main will fast-forward by 2 commits.');
    expect(describeIntegrationPlan(preview({ mode: 'up-to-date', ahead: 0 }))).toContain(
      'already in main'
    );
    expect(describeIntegrationPlan(preview({ mode: 'merge', behind: 1, ahead: 1 }))).toContain(
      'main has 1 commit this task'
    );
    expect(
      describeIntegrationPlan(preview({ mode: 'conflict', conflictedFiles: [gitPath('a.ts')] }))
    ).toContain('conflicts in 1 file');
  });

  it('adds the Chorus coordinator guard and details overlapping local changes', () => {
    const blockers = integrationBlockers(
      preview({
        target: { branch: 'refs/heads/chorus/main' as LocalBranchRef, head: 'aaa', changes: null },
        blockers: [{ kind: 'local-changes', paths: [gitPath('a.ts'), gitPath('b.ts')] }],
      })
    );
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toContain('Update Chorus');
    expect(blockers[1]).toContain('(a.ts, b.ts)');
    expect(integrationBlockers(preview())).toEqual([]);
  });
});

describe('resolution plan', () => {
  it('builds an isolated branch from the target branch', () => {
    expect(plan.taskName).toBe('Resolve Add Login Page! integration');
    expect(plan.branchName).toBe('emdash/resolve-add-login-page-x1y2z');
    expect(plan.fromBranch).toBe('main');
    expect(plan.manualSteps).toContain('git merge --no-ff --no-edit bbbbbbbb');
  });

  it('gives the agent the exact merge, the conflicts, and the safety rules', () => {
    expect(plan.prompt).toContain('`git merge --no-ff --no-edit bbbbbbbb`');
    expect(plan.prompt).toContain('- src/app.ts\n- README.md');
    expect(plan.prompt).toContain('Reason: Merge conflicts.');
    expect(plan.prompt).toContain('Do not push, force-push, rebase');
    expect(plan.prompt).toContain("project's main directory");
  });

  it('creates a Claude Code task that never auto-approves or pushes', () => {
    const params = buildResolutionTaskParams('project-1', plan, { initialPromptSupported: true });
    expect(params.projectId).toBe('project-1');
    expect(params.taskConfig.initialConversation).toMatchObject({
      provider: 'claude',
      type: 'pty',
      autoApprove: false,
      initialPrompt: plan.prompt,
    });
    expect(params.workspaceConfig).toEqual({
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: plan.branchName,
        fromBranch: { type: 'local', branch: 'main' },
        pushBranch: false,
      },
      workspace: { kind: 'new-worktree' },
    });
  });

  it('falls back to an agent-less task when Claude Code is unavailable', () => {
    const params = buildResolutionTaskParams('project-1', plan, null);
    expect(params.taskConfig.initialConversation).toBeUndefined();
    expect(params.workspaceConfig.git).toMatchObject({ kind: 'create-branch' });
  });

  it('slugs task names into branch-safe segments', () => {
    expect(slugForBranch('  Fix: the /API/ bug  ')).toBe('fix-the-api-bug');
    expect(slugForBranch('!!!')).toBe('task');
  });
});
