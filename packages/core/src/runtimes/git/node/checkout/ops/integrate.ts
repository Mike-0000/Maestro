import { err, ok, type Result } from '@emdash/shared';
import { parsePortableRelativePath, type PortableRelativePath } from '#primitives/path/api';
import {
  describeIntegrationBlocker,
  gitErr,
  shortName,
  type CheckoutHeadState,
  type CheckoutOperation,
  type CheckoutStatusState,
  type CheckoutStatusSummary,
  type IntegrateError,
  type IntegrateInput,
  type IntegrateResult,
  type IntegrationBlocker,
  type IntegrationCommit,
  type IntegrationMode,
  type IntegrationPreview,
  type LocalBranchRef,
} from '#runtimes/git/api';
import { commandFailure, gitFailure } from '#runtimes/git/node/exec/errors';
import { ExecError, type BoundExec } from '#services/exec/api';
import { computeHeadState } from './head';
import { computeStatusState } from './status';

/** One checkout taking part in an integration. Both sides must share one repository. */
export type IntegrationSide = Readonly<{
  exec: BoundExec;
  gitDir: string;
  checkoutId: string;
  repositoryId: string;
}>;

const INCOMING_COMMIT_SAMPLE = 20;
const MAX_REPORTED_PATHS = 500;

type SideState = Readonly<{
  head: CheckoutHeadState;
  status: CheckoutStatusState;
}>;

type Plan =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forward'; result: string }
  | { kind: 'merge'; tree: string }
  | { kind: 'conflict'; files: PortableRelativePath[] }
  | { kind: 'blocked'; blocker: IntegrationBlocker };

/**
 * Describes what integrating the source checkout's committed HEAD into the target
 * checkout's branch would do. Read-only: merge results are computed with
 * `git merge-tree`, which writes objects but never touches a worktree or ref.
 */
export async function previewIntegration(
  target: IntegrationSide,
  source: IntegrationSide
): Promise<IntegrationPreview> {
  const [targetState, sourceState] = await Promise.all([readSide(target), readSide(source)]);
  const blockers = structuralBlockers(target, source, targetState, sourceState);
  const targetHead = headOid(targetState.head);
  const sourceHead = headOid(sourceState.head);

  let mode: IntegrationMode | null = null;
  let ahead = 0;
  let behind = 0;
  let commits: IntegrationCommit[] = [];
  let changedFiles: PortableRelativePath[] = [];
  let conflictedFiles: PortableRelativePath[] = [];

  if (targetHead && sourceHead && target.repositoryId === source.repositoryId) {
    const plan = await planIntegration(target.exec, targetHead, sourceHead);
    [ahead, behind, commits] = await Promise.all([
      countCommits(target.exec, `${targetHead}..${sourceHead}`),
      countCommits(target.exec, `${sourceHead}..${targetHead}`),
      incomingCommits(target.exec, targetHead, sourceHead),
    ]);
    switch (plan.kind) {
      case 'blocked':
        blockers.push(plan.blocker);
        break;
      case 'conflict':
        mode = 'conflict';
        conflictedFiles = plan.files;
        changedFiles = await diffNames(target.exec, targetHead, sourceHead);
        break;
      case 'up-to-date':
        mode = 'up-to-date';
        break;
      case 'fast-forward':
      case 'merge': {
        mode = plan.kind;
        changedFiles = await diffNames(
          target.exec,
          targetHead,
          plan.kind === 'merge' ? plan.tree : plan.result
        );
        const overlap = overlappingLocalChanges(targetState.status, changedFiles);
        if (overlap.length > 0) blockers.push({ kind: 'local-changes', paths: overlap });
        break;
      }
    }
  }

  return {
    target: {
      branch: headBranch(targetState.head),
      head: targetHead,
      changes: statusSummary(targetState.status),
    },
    source: {
      branch: headBranch(sourceState.head),
      head: sourceHead,
      changes: statusSummary(sourceState.status),
    },
    mode,
    ahead,
    behind,
    commits,
    changedFiles: changedFiles.slice(0, MAX_REPORTED_PATHS),
    conflictedFiles: conflictedFiles.slice(0, MAX_REPORTED_PATHS),
    blockers,
  };
}

/**
 * Integrates the source checkout's committed HEAD into the target checkout's branch.
 *
 * A fast-forward moves the target directly. Otherwise the merge commit is created
 * off-tree (`merge-tree` + `commit-tree`) and the target is fast-forwarded to it, so a
 * conflict or refusal leaves the target branch, index, and worktree untouched.
 */
export async function integrate(
  target: IntegrationSide,
  source: IntegrationSide,
  input: Pick<IntegrateInput, 'expectedTargetHead' | 'expectedSourceHead' | 'message'>
): Promise<Result<IntegrateResult, IntegrateError>> {
  const [targetState, sourceState] = await Promise.all([readSide(target), readSide(source)]);
  const [blocker] = structuralBlockers(target, source, targetState, sourceState);
  if (blocker) return blocked(blocker);
  if (targetState.head.kind !== 'branch') return blocked({ kind: 'target-not-on-branch' });
  const branch = targetState.head.ref;
  const targetHead = targetState.head.oid;
  const sourceHead = headOid(sourceState.head);
  if (!sourceHead) return blocked({ kind: 'source-not-committed' });

  if (targetHead !== input.expectedTargetHead) {
    return err({
      type: 'target_moved',
      message: `${shortName(branch)} moved since it was checked. Review the integration again.`,
    });
  }
  if (sourceHead !== input.expectedSourceHead) {
    return err({
      type: 'source_moved',
      message: 'The task has new commits since it was checked. Review the integration again.',
    });
  }

  const plan = await planIntegration(target.exec, targetHead, sourceHead);
  let next: string;
  switch (plan.kind) {
    case 'blocked':
      return blocked(plan.blocker);
    case 'up-to-date':
      return ok({ mode: 'up-to-date', branch, previousHead: targetHead, commit: targetHead });
    case 'conflict':
      return gitErr.conflict(
        `Integrating into ${shortName(branch)} conflicts in ${plan.files.length} file(s).`,
        plan.files.slice(0, MAX_REPORTED_PATHS)
      );
    case 'fast-forward':
      next = plan.result;
      break;
    case 'merge': {
      const message =
        input.message?.trim() ||
        `Merge ${describeSource(sourceState.head, sourceHead)} into ${shortName(branch)}`;
      try {
        const { stdout } = await target.exec.exec([
          'commit-tree',
          plan.tree,
          '-p',
          targetHead,
          '-p',
          sourceHead,
          '-m',
          message,
        ]);
        next = stdout.trim();
      } catch (error) {
        return commandFailure(gitFailure(error));
      }
      break;
    }
  }

  try {
    await target.exec.exec(['merge', '--ff-only', next]);
  } catch (error) {
    return fastForwardFailure(error);
  }
  return ok({
    mode: plan.kind === 'fast-forward' ? 'fast-forward' : 'merge',
    branch,
    previousHead: targetHead,
    commit: next,
  });
}

async function readSide(side: IntegrationSide): Promise<SideState> {
  const [head, status] = await Promise.all([
    computeHeadState(side.exec),
    computeStatusState(side.exec, side.gitDir),
  ]);
  return { head, status };
}

function structuralBlockers(
  target: IntegrationSide,
  source: IntegrationSide,
  targetState: SideState,
  sourceState: SideState
): IntegrationBlocker[] {
  const blockers: IntegrationBlocker[] = [];
  if (target.checkoutId === source.checkoutId) blockers.push({ kind: 'same-checkout' });
  else if (target.repositoryId !== source.repositoryId) {
    blockers.push({ kind: 'different-repository' });
  }
  if (targetState.head.kind !== 'branch') blockers.push({ kind: 'target-not-on-branch' });
  if (sourceState.head.kind === 'unborn') blockers.push({ kind: 'source-not-committed' });
  if (
    target.checkoutId !== source.checkoutId &&
    targetState.head.kind === 'branch' &&
    sourceState.head.kind === 'branch' &&
    targetState.head.ref === sourceState.head.ref
  ) {
    blockers.push({ kind: 'same-branch' });
  }
  const targetOperation = operationOf(targetState.status);
  if (targetOperation !== 'none') {
    blockers.push({ kind: 'target-operation', operation: targetOperation });
  }
  const sourceOperation = operationOf(sourceState.status);
  if (sourceOperation !== 'none') {
    blockers.push({ kind: 'source-operation', operation: sourceOperation });
  }
  return blockers;
}

async function planIntegration(exec: BoundExec, target: string, source: string): Promise<Plan> {
  if (await isAncestor(exec, source, target)) return { kind: 'up-to-date' };
  if (await isAncestor(exec, target, source)) return { kind: 'fast-forward', result: source };
  try {
    const { stdout } = await exec.exec([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      target,
      source,
    ]);
    return { kind: 'merge', tree: parseMergeTree(stdout).tree };
  } catch (error) {
    const failure = gitFailure(error);
    if (failure.exitCode === 1 && failure.stdout.trim()) {
      return { kind: 'conflict', files: parseMergeTree(failure.stdout).files };
    }
    const message = failure.message.toLowerCase();
    if (message.includes('unrelated histories')) {
      return { kind: 'blocked', blocker: { kind: 'unrelated-histories' } };
    }
    if (
      failure.exitCode === 129 ||
      message.includes('unknown option') ||
      message.includes('usage: git merge-tree')
    ) {
      return {
        kind: 'blocked',
        blocker: {
          kind: 'merge-unsupported',
          message: 'Integrating diverged branches requires Git 2.38 or newer on this host.',
        },
      };
    }
    throw error;
  }
}

/** Parses `merge-tree --write-tree --name-only --no-messages -z` output. */
export function parseMergeTree(stdout: string): { tree: string; files: PortableRelativePath[] } {
  const [tree = '', ...rest] = stdout.split('\0');
  const files = [...new Set(rest.filter(Boolean))].map(toPortablePath);
  return { tree: tree.trim(), files };
}

async function isAncestor(exec: BoundExec, ancestor: string, descendant: string) {
  try {
    await exec.exec(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof ExecError && error.exitCode === 1) return false;
    throw error;
  }
}

async function countCommits(exec: BoundExec, range: string): Promise<number> {
  const { stdout } = await exec.exec(['rev-list', '--count', range]);
  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function incomingCommits(
  exec: BoundExec,
  target: string,
  source: string
): Promise<IntegrationCommit[]> {
  const { stdout } = await exec.exec([
    'log',
    `--max-count=${INCOMING_COMMIT_SAMPLE}`,
    '--format=%H%x1f%s',
    `${target}..${source}`,
  ]);
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = ''] = line.split('\x1f');
      return { hash, subject };
    });
}

async function diffNames(exec: BoundExec, from: string, to: string) {
  const { stdout } = await exec.exec(['diff', '--name-only', '--no-renames', '-z', from, to]);
  return stdout.split('\0').filter(Boolean).map(toPortablePath);
}

/**
 * Paths that are dirty (tracked or untracked) in the target and also change on
 * integration. Git refuses such fast-forwards; surfacing them up front explains why.
 */
function overlappingLocalChanges(
  status: CheckoutStatusState,
  incoming: readonly PortableRelativePath[]
): PortableRelativePath[] {
  if (status.kind !== 'ok') return [];
  const incomingSet = new Set(incoming);
  return Object.values(status.entries)
    .filter((entry) => entry.index !== 'ignored' && entry.worktree !== 'ignored')
    .map((entry) => entry.path)
    .filter((entryPath) => incomingSet.has(entryPath))
    .slice(0, MAX_REPORTED_PATHS);
}

function fastForwardFailure(error: unknown): Result<never, IntegrateError> {
  const failure = gitFailure(error);
  const message = failure.message.toLowerCase();
  if (message.includes('would be overwritten')) {
    return err({
      type: 'local_changes',
      message: failure.message,
      paths: parseOverwrittenPaths(failure.message),
    });
  }
  if (message.includes('not possible to fast-forward')) {
    return err({ type: 'target_moved', message: failure.message });
  }
  return commandFailure(failure);
}

/** Git lists the refused paths as tab-indented lines inside the error message. */
export function parseOverwrittenPaths(message: string): PortableRelativePath[] {
  const paths: PortableRelativePath[] = [];
  for (const line of message.split(/\r?\n/)) {
    if (!line.startsWith('\t')) continue;
    const parsed = parsePortableRelativePath(line.trim(), { unicodeNormalization: 'preserve' });
    if (parsed.success && parsed.data) paths.push(parsed.data);
  }
  return paths;
}

function blocked(blocker: IntegrationBlocker): Result<never, IntegrateError> {
  return err({ type: 'blocked', message: describeIntegrationBlocker(blocker), blocker });
}

function describeSource(head: CheckoutHeadState, oid: string): string {
  return head.kind === 'branch' ? `branch '${shortName(head.ref)}'` : `commit ${oid.slice(0, 12)}`;
}

function headOid(head: CheckoutHeadState): string | null {
  return head.kind === 'unborn' ? null : head.oid;
}

function headBranch(head: CheckoutHeadState): LocalBranchRef | null {
  return head.kind === 'branch' ? head.ref : null;
}

function statusSummary(status: CheckoutStatusState): CheckoutStatusSummary | null {
  return status.kind === 'ok' ? status.summary : null;
}

function operationOf(status: CheckoutStatusState): CheckoutOperation {
  return status.kind === 'ok' ? status.operation : 'none';
}

function toPortablePath(filePath: string): PortableRelativePath {
  const parsed = parsePortableRelativePath(filePath, { unicodeNormalization: 'preserve' });
  if (!parsed.success || !parsed.data) {
    throw new Error(`Git reported an invalid path: ${filePath}`);
  }
  return parsed.data;
}
